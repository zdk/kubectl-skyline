package cluster

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
)

type Watcher struct {
	client    kubernetes.Interface
	metrics   metricsclient.Interface
	context   string
	namespace string
	factory   informers.SharedInformerFactory
	start     time.Time

	mu       sync.RWMutex
	snapshot *Snapshot
	dirty    chan struct{}

	subMu sync.Mutex
	subs  map[chan Message]struct{}

	lister listers
}

type listers struct {
	namespaces   cache.Indexer
	nodes        cache.Indexer
	pods         cache.Indexer
	deployments  cache.Indexer
	replicasets  cache.Indexer
	statefulsets cache.Indexer
	daemonsets   cache.Indexer
	jobs         cache.Indexer
	cronjobs     cache.Indexer
	services     cache.Indexer
	ingresses    cache.Indexer
	configmaps   cache.Indexer
	secrets      cache.Indexer
	pvcs         cache.Indexer
	events       cache.Indexer
}

const keysAnnotation = "skyline/keys"

type Message struct {
	Type string
	Data interface{}
}

func New(client kubernetes.Interface, metrics metricsclient.Interface, kubeContext, namespace string) *Watcher {
	w := &Watcher{
		client:    client,
		metrics:   metrics,
		context:   kubeContext,
		namespace: namespace,
		start:     time.Now(),
		dirty:     make(chan struct{}, 1),
		subs:      map[chan Message]struct{}{},
		snapshot:  &Snapshot{Context: kubeContext, Generated: time.Now()},
	}
	return w
}

func (w *Watcher) Run(ctx context.Context) error {
	opts := []informers.SharedInformerOption{}
	if w.namespace != "" {
		opts = append(opts, informers.WithNamespace(w.namespace))
	}
	w.factory = informers.NewSharedInformerFactoryWithOptions(w.client, 10*time.Minute, opts...)
	f := w.factory

	secrets := f.Core().V1().Secrets().Informer()
	if err := secrets.SetTransform(func(obj interface{}) (interface{}, error) {
		if s, ok := obj.(*corev1.Secret); ok {
			if _, done := s.Annotations[keysAnnotation]; done && len(s.Data) == 0 && len(s.StringData) == 0 {
				return s, nil
			}
			s = s.DeepCopy()
			keys := make([]string, 0, len(s.Data)+len(s.StringData))
			for k := range s.Data {
				keys = append(keys, k)
			}
			for k := range s.StringData {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			s.Data = nil
			s.StringData = nil
			if s.Annotations == nil {
				s.Annotations = map[string]string{}
			}
			s.Annotations[keysAnnotation] = strings.Join(keys, ",")
			return s, nil
		}
		return obj, nil
	}); err != nil {
		return err
	}

	cms := f.Core().V1().ConfigMaps().Informer()
	if err := cms.SetTransform(func(obj interface{}) (interface{}, error) {
		if c, ok := obj.(*corev1.ConfigMap); ok {
			if _, done := c.Annotations[keysAnnotation]; done && len(c.Data) == 0 && len(c.BinaryData) == 0 {
				return c, nil
			}
			c = c.DeepCopy()
			keys := make([]string, 0, len(c.Data)+len(c.BinaryData))
			for k := range c.Data {
				keys = append(keys, k)
			}
			for k := range c.BinaryData {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			c.Data = nil
			c.BinaryData = nil
			if c.Annotations == nil {
				c.Annotations = map[string]string{}
			}
			c.Annotations[keysAnnotation] = strings.Join(keys, ",")
			return c, nil
		}
		return obj, nil
	}); err != nil {
		return err
	}

	all := []cache.SharedIndexInformer{
		f.Core().V1().Nodes().Informer(),
		f.Core().V1().Pods().Informer(),
		f.Apps().V1().Deployments().Informer(),
		f.Apps().V1().ReplicaSets().Informer(),
		f.Apps().V1().StatefulSets().Informer(),
		f.Apps().V1().DaemonSets().Informer(),
		f.Batch().V1().Jobs().Informer(),
		f.Batch().V1().CronJobs().Informer(),
		f.Core().V1().Services().Informer(),
		f.Networking().V1().Ingresses().Informer(),
		cms,
		secrets,
		f.Core().V1().PersistentVolumeClaims().Informer(),
	}

	nsFactory := w.factory
	if w.namespace != "" {
		nsFactory = informers.NewSharedInformerFactory(w.client, 10*time.Minute)
	}
	nsInformer := nsFactory.Core().V1().Namespaces().Informer()
	all = append(all, nsInformer)

	mark := cache.ResourceEventHandlerFuncs{
		AddFunc:    func(interface{}) { w.markDirty() },
		UpdateFunc: func(_, _ interface{}) { w.markDirty() },
		DeleteFunc: func(interface{}) { w.markDirty() },
	}
	for _, inf := range all {
		if _, err := inf.AddEventHandler(mark); err != nil {
			return err
		}
	}

	events := f.Core().V1().Events().Informer()
	if _, err := events.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    func(obj interface{}) { w.forwardEvent(obj) },
		UpdateFunc: func(_, obj interface{}) { w.forwardEvent(obj) },
	}); err != nil {
		return err
	}

	w.lister = listers{
		namespaces:   nsInformer.GetIndexer(),
		nodes:        f.Core().V1().Nodes().Informer().GetIndexer(),
		pods:         f.Core().V1().Pods().Informer().GetIndexer(),
		deployments:  f.Apps().V1().Deployments().Informer().GetIndexer(),
		replicasets:  f.Apps().V1().ReplicaSets().Informer().GetIndexer(),
		statefulsets: f.Apps().V1().StatefulSets().Informer().GetIndexer(),
		daemonsets:   f.Apps().V1().DaemonSets().Informer().GetIndexer(),
		jobs:         f.Batch().V1().Jobs().Informer().GetIndexer(),
		cronjobs:     f.Batch().V1().CronJobs().Informer().GetIndexer(),
		services:     f.Core().V1().Services().Informer().GetIndexer(),
		ingresses:    f.Networking().V1().Ingresses().Informer().GetIndexer(),
		configmaps:   cms.GetIndexer(),
		secrets:      secrets.GetIndexer(),
		pvcs:         f.Core().V1().PersistentVolumeClaims().Informer().GetIndexer(),
		events:       events.GetIndexer(),
	}

	f.Start(ctx.Done())
	if nsFactory != f {
		nsFactory.Start(ctx.Done())
	}
	log.Printf("syncing informers for context %q", w.context)
	synced := f.WaitForCacheSync(ctx.Done())
	for typ, ok := range synced {
		if !ok {
			log.Printf("warning: informer for %v did not sync (RBAC?)", typ)
		}
	}
	if nsFactory != f {
		nsFactory.WaitForCacheSync(ctx.Done())
	}
	log.Printf("informers synced")
	w.rebuild()

	if w.metrics != nil {
		go w.pollMetrics(ctx)
	}

	timer := time.NewTimer(time.Hour)
	timer.Stop()
	pending := false
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-w.dirty:
			if !pending {
				pending = true
				timer.Reset(250 * time.Millisecond)
			}
		case <-timer.C:
			pending = false
			w.rebuild()
		}
	}
}

func (w *Watcher) markDirty() {
	select {
	case w.dirty <- struct{}{}:
	default:
	}
}

func (w *Watcher) Snapshot() *Snapshot {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.snapshot
}

func (w *Watcher) Subscribe() (<-chan Message, func()) {
	ch := make(chan Message, 64)
	w.subMu.Lock()
	w.subs[ch] = struct{}{}
	w.subMu.Unlock()
	ch <- Message{Type: "snapshot", Data: w.Snapshot()}
	return ch, func() {
		w.subMu.Lock()
		delete(w.subs, ch)
		w.subMu.Unlock()
	}
}

func (w *Watcher) publish(m Message) {
	w.subMu.Lock()
	defer w.subMu.Unlock()
	for ch := range w.subs {
		select {
		case ch <- m:
		default:

		}
	}
}

func (w *Watcher) forwardEvent(obj interface{}) {
	ev, ok := obj.(*corev1.Event)
	if !ok {
		return
	}
	ts := ev.LastTimestamp.Time
	if ts.IsZero() {
		ts = ev.EventTime.Time
	}
	if ts.IsZero() {
		ts = ev.CreationTimestamp.Time
	}
	if ts.Before(w.start) {
		return
	}
	io := ev.InvolvedObject
	w.publish(Message{Type: "event", Data: Event{
		Target:  nodeID(io.Kind, io.Namespace, io.Name),
		Type:    ev.Type,
		Reason:  ev.Reason,
		Message: ev.Message,
		Count:   ev.Count,
		Time:    ts,
	}})
}

func (w *Watcher) EventsFor(kind, namespace, name string) []Event {
	var out []Event
	for _, obj := range w.lister.events.List() {
		ev, ok := obj.(*corev1.Event)
		if !ok {
			continue
		}
		io := ev.InvolvedObject
		if io.Kind != kind || io.Namespace != namespace || io.Name != name {
			continue
		}
		ts := ev.LastTimestamp.Time
		if ts.IsZero() {
			ts = ev.EventTime.Time
		}
		out = append(out, Event{
			Target: nodeID(kind, namespace, name), Type: ev.Type, Reason: ev.Reason,
			Message: ev.Message, Count: ev.Count, Time: ts,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Time.After(out[j].Time) })
	return out
}

func (w *Watcher) Get(kind, namespace, name string) runtime.Object {
	var idx cache.Indexer
	switch kind {
	case "Namespace":
		idx = w.lister.namespaces
	case "Node":
		idx = w.lister.nodes
	case "Pod":
		idx = w.lister.pods
	case "Deployment":
		idx = w.lister.deployments
	case "ReplicaSet":
		idx = w.lister.replicasets
	case "StatefulSet":
		idx = w.lister.statefulsets
	case "DaemonSet":
		idx = w.lister.daemonsets
	case "Job":
		idx = w.lister.jobs
	case "CronJob":
		idx = w.lister.cronjobs
	case "Service":
		idx = w.lister.services
	case "Ingress":
		idx = w.lister.ingresses
	case "ConfigMap":
		idx = w.lister.configmaps
	case "Secret":
		idx = w.lister.secrets
	case "PersistentVolumeClaim":
		idx = w.lister.pvcs
	default:
		return nil
	}
	key := name
	if namespace != "" {
		key = namespace + "/" + name
	}
	obj, ok, err := idx.GetByKey(key)
	if err != nil || !ok {
		return nil
	}
	if ro, ok := obj.(runtime.Object); ok {
		return ro
	}
	return nil
}

func nodeID(kind, namespace, name string) string {
	return kind + "/" + namespace + "/" + name
}

func (w *Watcher) rebuild() {
	b := &builder{nodes: map[string]*Node{}}
	l := w.lister

	for _, o := range l.namespaces.List() {
		ns := o.(*corev1.Namespace)
		if w.namespace != "" && ns.Name != w.namespace {
			continue
		}
		n := b.add("Namespace", "", ns.Name, ns.ObjectMeta)
		n.Phase = string(ns.Status.Phase)
		n.Status = "ok"
		if ns.Status.Phase == corev1.NamespaceTerminating {
			n.Status = "warn"
		}
		n.Summary = n.Phase
	}
	for _, o := range l.nodes.List() {
		kn := o.(*corev1.Node)
		n := b.add("Node", "", kn.Name, kn.ObjectMeta)
		ready := false
		for _, c := range kn.Status.Conditions {
			if c.Type == corev1.NodeReady && c.Status == corev1.ConditionTrue {
				ready = true
			}
		}
		n.Status, n.Phase = "ok", "Ready"
		if !ready {
			n.Status, n.Phase = "error", "NotReady"
		}
		if kn.Spec.Unschedulable {
			n.Status, n.Phase = "warn", n.Phase+",SchedulingDisabled"
		}
		roles := []string{}
		for k := range kn.Labels {
			if strings.HasPrefix(k, "node-role.kubernetes.io/") {
				roles = append(roles, strings.TrimPrefix(k, "node-role.kubernetes.io/"))
			}
		}
		sort.Strings(roles)
		cpu := kn.Status.Allocatable.Cpu()
		mem := kn.Status.Allocatable.Memory()
		n.Summary = fmt.Sprintf("%s · %s · cpu %s · mem %s", n.Phase, strings.Join(roles, ","), cpu.String(), humanBytes(mem.Value()))
		n.Facts = [][2]string{
			{"Roles", strings.Join(roles, ", ")},
			{"Kubelet", kn.Status.NodeInfo.KubeletVersion},
			{"OS", kn.Status.NodeInfo.OSImage},
			{"Kernel", kn.Status.NodeInfo.KernelVersion},
			{"Runtime", kn.Status.NodeInfo.ContainerRuntimeVersion},
			{"Arch", kn.Status.NodeInfo.Architecture},
			{"Allocatable CPU", cpu.String()},
			{"Allocatable memory", humanBytes(mem.Value())},
			{"Allocatable pods", kn.Status.Allocatable.Pods().String()},
		}
		for _, a := range kn.Status.Addresses {
			n.Facts = append(n.Facts, [2]string{string(a.Type), a.Address})
		}
	}

	for _, o := range l.deployments.List() {
		d := o.(*appsv1.Deployment)
		n := b.add("Deployment", d.Namespace, d.Name, d.ObjectMeta)
		desired := int32(1)
		if d.Spec.Replicas != nil {
			desired = *d.Spec.Replicas
		}
		n.Desired, n.Ready = desired, d.Status.ReadyReplicas
		n.Status = replicaStatus(desired, d.Status.ReadyReplicas)
		n.Phase = fmt.Sprintf("%d/%d", d.Status.ReadyReplicas, desired)
		n.Summary = fmt.Sprintf("%s ready · %d up-to-date · %d available", n.Phase, d.Status.UpdatedReplicas, d.Status.AvailableReplicas)
		n.Facts = [][2]string{{"Strategy", string(d.Spec.Strategy.Type)}, {"Selector", metav1.FormatLabelSelector(d.Spec.Selector)}}
		for _, c := range d.Status.Conditions {
			if c.Status != corev1.ConditionTrue || c.Type == appsv1.DeploymentAvailable {
				continue
			}
			n.Facts = append(n.Facts, [2]string{string(c.Type), c.Reason})
		}
	}
	for _, o := range l.replicasets.List() {
		rs := o.(*appsv1.ReplicaSet)
		n := b.add("ReplicaSet", rs.Namespace, rs.Name, rs.ObjectMeta)
		desired := int32(1)
		if rs.Spec.Replicas != nil {
			desired = *rs.Spec.Replicas
		}
		n.Desired, n.Ready = desired, rs.Status.ReadyReplicas
		n.Status = replicaStatus(desired, rs.Status.ReadyReplicas)
		if desired == 0 && rs.Status.Replicas == 0 {
			n.Status = "idle"
		}
		n.Phase = fmt.Sprintf("%d/%d", rs.Status.ReadyReplicas, desired)
		n.Summary = n.Phase + " ready"
		if rev := rs.Annotations["deployment.kubernetes.io/revision"]; rev != "" {
			n.Summary += " · revision " + rev
			n.Facts = append(n.Facts, [2]string{"Revision", rev})
		}
	}
	for _, o := range l.statefulsets.List() {
		s := o.(*appsv1.StatefulSet)
		n := b.add("StatefulSet", s.Namespace, s.Name, s.ObjectMeta)
		desired := int32(1)
		if s.Spec.Replicas != nil {
			desired = *s.Spec.Replicas
		}
		n.Desired, n.Ready = desired, s.Status.ReadyReplicas
		n.Status = replicaStatus(desired, s.Status.ReadyReplicas)
		n.Phase = fmt.Sprintf("%d/%d", s.Status.ReadyReplicas, desired)
		n.Summary = n.Phase + " ready · service " + s.Spec.ServiceName
		n.Facts = [][2]string{{"Service", s.Spec.ServiceName}, {"Update strategy", string(s.Spec.UpdateStrategy.Type)}}
	}
	for _, o := range l.daemonsets.List() {
		d := o.(*appsv1.DaemonSet)
		n := b.add("DaemonSet", d.Namespace, d.Name, d.ObjectMeta)
		n.Desired, n.Ready = d.Status.DesiredNumberScheduled, d.Status.NumberReady
		n.Status = replicaStatus(d.Status.DesiredNumberScheduled, d.Status.NumberReady)
		n.Phase = fmt.Sprintf("%d/%d", d.Status.NumberReady, d.Status.DesiredNumberScheduled)
		n.Summary = n.Phase + " ready"
		if d.Status.NumberMisscheduled > 0 {
			n.Summary += fmt.Sprintf(" · %d misscheduled", d.Status.NumberMisscheduled)
		}
	}
	for _, o := range l.jobs.List() {
		j := o.(*batchv1.Job)
		n := b.add("Job", j.Namespace, j.Name, j.ObjectMeta)
		completions := int32(1)
		if j.Spec.Completions != nil {
			completions = *j.Spec.Completions
		}
		n.Desired, n.Ready = completions, j.Status.Succeeded
		n.Phase = "Running"
		n.Status = "warn"
		for _, c := range j.Status.Conditions {
			if c.Status != corev1.ConditionTrue {
				continue
			}
			if c.Type == batchv1.JobComplete {
				n.Phase, n.Status = "Complete", "done"
			}
			if c.Type == batchv1.JobFailed {
				n.Phase, n.Status = "Failed", "error"
			}
		}
		if j.Status.Active > 0 {
			n.Status = "ok"
		}
		n.Summary = fmt.Sprintf("%s · %d/%d succeeded · %d active · %d failed", n.Phase, j.Status.Succeeded, completions, j.Status.Active, j.Status.Failed)
	}
	for _, o := range l.cronjobs.List() {
		c := o.(*batchv1.CronJob)
		n := b.add("CronJob", c.Namespace, c.Name, c.ObjectMeta)
		n.Status, n.Phase = "ok", "Scheduled"
		if c.Spec.Suspend != nil && *c.Spec.Suspend {
			n.Status, n.Phase = "idle", "Suspended"
		}
		n.Summary = c.Spec.Schedule
		if c.Status.LastScheduleTime != nil {
			n.Summary += " · last " + c.Status.LastScheduleTime.Format("15:04:05")
		}
		n.Facts = [][2]string{{"Schedule", c.Spec.Schedule}, {"Active jobs", fmt.Sprint(len(c.Status.Active))}}
	}

	podsByNS := map[string][]*corev1.Pod{}
	for _, o := range l.pods.List() {
		p := o.(*corev1.Pod)
		podsByNS[p.Namespace] = append(podsByNS[p.Namespace], p)
		n := b.add("Pod", p.Namespace, p.Name, p.ObjectMeta)
		n.ClusterNode = p.Spec.NodeName
		fillPod(n, p)
		for _, ref := range podRefs(p) {
			b.edge(n.ID, nodeID(ref.kind, p.Namespace, ref.name), "mount")
		}
	}
	for _, o := range l.services.List() {
		s := o.(*corev1.Service)
		n := b.add("Service", s.Namespace, s.Name, s.ObjectMeta)
		n.Status, n.Phase = "ok", string(s.Spec.Type)
		ports := make([]string, 0, len(s.Spec.Ports))
		for _, p := range s.Spec.Ports {
			ps := fmt.Sprintf("%d/%s", p.Port, p.Protocol)
			if p.NodePort != 0 {
				ps = fmt.Sprintf("%d:%d/%s", p.Port, p.NodePort, p.Protocol)
			}
			ports = append(ports, ps)
		}
		n.Summary = fmt.Sprintf("%s · %s · %s", s.Spec.Type, s.Spec.ClusterIP, strings.Join(ports, ","))
		n.Facts = [][2]string{{"Cluster IP", s.Spec.ClusterIP}, {"Ports", strings.Join(ports, ", ")}, {"Selector", labels.FormatLabels(s.Spec.Selector)}}
		for _, ing := range s.Status.LoadBalancer.Ingress {
			addr := ing.IP
			if addr == "" {
				addr = ing.Hostname
			}
			n.Facts = append(n.Facts, [2]string{"External", addr})
		}
		if len(s.Spec.Selector) == 0 {
			if s.Spec.Type != corev1.ServiceTypeExternalName {
				n.Status = "idle"
			}
			continue
		}
		sel := labels.SelectorFromSet(s.Spec.Selector)
		matched := 0
		for _, p := range podsByNS[s.Namespace] {
			if sel.Matches(labels.Set(p.Labels)) {
				b.edge(n.ID, nodeID("Pod", p.Namespace, p.Name), "select")
				matched++
			}
		}
		if matched == 0 {
			n.Status = "warn"
			n.Summary += " · no endpoints"
		}
	}
	for _, o := range l.ingresses.List() {
		in := o.(*networkingv1.Ingress)
		n := b.add("Ingress", in.Namespace, in.Name, in.ObjectMeta)
		n.Status, n.Phase = "ok", "Ingress"
		hosts := []string{}
		backend := func(bk *networkingv1.IngressBackend) {
			if bk != nil && bk.Service != nil {
				b.edge(n.ID, nodeID("Service", in.Namespace, bk.Service.Name), "route")
			}
		}
		backend(in.Spec.DefaultBackend)
		for _, r := range in.Spec.Rules {
			if r.Host != "" {
				hosts = append(hosts, r.Host)
			}
			if r.HTTP == nil {
				continue
			}
			for _, p := range r.HTTP.Paths {
				backend(&p.Backend)
			}
		}
		n.Summary = strings.Join(hosts, ", ")
		if n.Summary == "" {
			n.Summary = "*"
		}
		if in.Spec.IngressClassName != nil {
			n.Facts = append(n.Facts, [2]string{"Class", *in.Spec.IngressClassName})
		}
		for _, lb := range in.Status.LoadBalancer.Ingress {
			addr := lb.IP
			if addr == "" {
				addr = lb.Hostname
			}
			n.Facts = append(n.Facts, [2]string{"Address", addr})
		}
	}
	for _, o := range l.configmaps.List() {
		c := o.(*corev1.ConfigMap)
		n := b.add("ConfigMap", c.Namespace, c.Name, c.ObjectMeta)
		keys := splitKeys(c.Annotations[keysAnnotation])
		n.Status, n.Phase = "ok", fmt.Sprintf("%d keys", len(keys))
		n.Summary = strings.Join(keys, ", ")
		n.Facts = [][2]string{{"Keys", strings.Join(keys, ", ")}}
	}
	for _, o := range l.secrets.List() {
		s := o.(*corev1.Secret)
		n := b.add("Secret", s.Namespace, s.Name, s.ObjectMeta)
		keys := splitKeys(s.Annotations[keysAnnotation])
		n.Status, n.Phase = "ok", string(s.Type)
		n.Summary = fmt.Sprintf("%s · %d keys", s.Type, len(keys))
		n.Facts = [][2]string{{"Type", string(s.Type)}, {"Keys", strings.Join(keys, ", ")}}
	}
	for _, o := range l.pvcs.List() {
		c := o.(*corev1.PersistentVolumeClaim)
		n := b.add("PersistentVolumeClaim", c.Namespace, c.Name, c.ObjectMeta)
		n.Phase = string(c.Status.Phase)
		switch c.Status.Phase {
		case corev1.ClaimBound:
			n.Status = "ok"
		case corev1.ClaimLost:
			n.Status = "error"
		default:
			n.Status = "warn"
		}
		size := c.Status.Capacity.Storage()
		if size == nil || size.IsZero() {
			size = c.Spec.Resources.Requests.Storage()
		}
		sc := ""
		if c.Spec.StorageClassName != nil {
			sc = *c.Spec.StorageClassName
		}
		n.Summary = fmt.Sprintf("%s · %s · %s", n.Phase, size.String(), sc)
		n.Facts = [][2]string{{"Volume", c.Spec.VolumeName}, {"Storage class", sc}, {"Capacity", size.String()}}
	}

	for _, n := range b.nodes {
		if n.Owner != "" {
			if _, ok := b.nodes[n.Owner]; ok {
				b.edge(n.Owner, n.ID, "owner")
			} else {
				n.Owner = ""
			}
		}
	}

	edges := b.edges[:0]
	for _, e := range b.edges {
		if _, ok := b.nodes[e.From]; !ok {
			continue
		}
		if _, ok := b.nodes[e.To]; !ok {
			continue
		}
		edges = append(edges, e)
	}

	nodes := make([]*Node, 0, len(b.nodes))
	for _, n := range b.nodes {
		nodes = append(nodes, n)
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].From != edges[j].From {
			return edges[i].From < edges[j].From
		}
		return edges[i].To < edges[j].To
	})
	snap := &Snapshot{Context: w.context, Generated: time.Now(), Nodes: nodes, Edges: edges}
	w.mu.Lock()
	w.snapshot = snap
	w.mu.Unlock()
	w.publish(Message{Type: "snapshot", Data: snap})
}

type builder struct {
	nodes map[string]*Node
	edges []Edge
}

var ownerKinds = map[string]bool{
	"Deployment": true, "ReplicaSet": true, "StatefulSet": true, "DaemonSet": true, "Job": true, "CronJob": true,
}

func (b *builder) add(kind, namespace, name string, meta metav1.ObjectMeta) *Node {
	n := &Node{
		ID: nodeID(kind, namespace, name), Kind: kind, Name: name, Namespace: namespace,
		UID: string(meta.UID), Labels: meta.Labels, Created: meta.CreationTimestamp.Time, Status: "unknown",
	}
	for _, ref := range meta.OwnerReferences {
		if ref.Controller != nil && *ref.Controller && ownerKinds[ref.Kind] {
			n.Owner = nodeID(ref.Kind, namespace, ref.Name)
			break
		}
	}
	if meta.DeletionTimestamp != nil {
		n.Facts = append(n.Facts, [2]string{"Deleting since", meta.DeletionTimestamp.Format(time.RFC3339)})
	}
	b.nodes[n.ID] = n
	return n
}

func (b *builder) edge(from, to, kind string) {
	b.edges = append(b.edges, Edge{From: from, To: to, Kind: kind})
}

func replicaStatus(desired, ready int32) string {
	switch {
	case desired == 0:
		return "idle"
	case ready >= desired:
		return "ok"
	case ready == 0:
		return "error"
	default:
		return "warn"
	}
}

func splitKeys(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(s, ",")
}

func humanBytes(v int64) string {
	const unit = 1024
	if v < unit {
		return fmt.Sprintf("%dB", v)
	}
	div, exp := int64(unit), 0
	for n := v / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%ciB", float64(v)/float64(div), "KMGTPE"[exp])
}

func quantityString(q *resource.Quantity) string {
	if q == nil || q.IsZero() {
		return ""
	}
	return q.String()
}
