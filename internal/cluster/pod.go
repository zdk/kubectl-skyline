package cluster

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type ref struct{ kind, name string }

func podRefs(p *corev1.Pod) []ref {
	seen := map[ref]bool{}
	var out []ref
	add := func(kind, name string) {
		if name == "" {
			return
		}
		r := ref{kind, name}
		if !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	for _, v := range p.Spec.Volumes {
		switch {
		case v.ConfigMap != nil:
			add("ConfigMap", v.ConfigMap.Name)
		case v.Secret != nil:
			add("Secret", v.Secret.SecretName)
		case v.PersistentVolumeClaim != nil:
			add("PersistentVolumeClaim", v.PersistentVolumeClaim.ClaimName)
		case v.Projected != nil:
			for _, s := range v.Projected.Sources {
				if s.ConfigMap != nil {
					add("ConfigMap", s.ConfigMap.Name)
				}
				if s.Secret != nil {
					add("Secret", s.Secret.Name)
				}
			}
		}
	}
	containers := append(append([]corev1.Container{}, p.Spec.InitContainers...), p.Spec.Containers...)
	for _, c := range containers {
		for _, e := range c.EnvFrom {
			if e.ConfigMapRef != nil {
				add("ConfigMap", e.ConfigMapRef.Name)
			}
			if e.SecretRef != nil {
				add("Secret", e.SecretRef.Name)
			}
		}
		for _, e := range c.Env {
			if e.ValueFrom == nil {
				continue
			}
			if e.ValueFrom.ConfigMapKeyRef != nil {
				add("ConfigMap", e.ValueFrom.ConfigMapKeyRef.Name)
			}
			if e.ValueFrom.SecretKeyRef != nil {
				add("Secret", e.ValueFrom.SecretKeyRef.Name)
			}
		}
	}
	for _, s := range p.Spec.ImagePullSecrets {
		add("Secret", s.Name)
	}
	return out
}

func fillPod(n *Node, p *corev1.Pod) {
	statusByName := map[string]corev1.ContainerStatus{}
	for _, s := range p.Status.InitContainerStatuses {
		statusByName["init:"+s.Name] = s
	}
	for _, s := range p.Status.ContainerStatuses {
		statusByName[s.Name] = s
	}
	var restarts int32
	ready, total := 0, len(p.Spec.Containers)
	reason := string(p.Status.Phase)
	if p.Status.Reason != "" {
		reason = p.Status.Reason
	}
	initializing := false
	for i, c := range p.Spec.InitContainers {
		s := statusByName["init:"+c.Name]
		cs := Container{Name: c.Name, Image: c.Image, Init: true, Restarts: s.RestartCount, Ready: s.Ready}
		cs.CPUReq, cs.MemReq = quantityString(c.Resources.Requests.Cpu()), quantityString(c.Resources.Requests.Memory())
		cs.State, cs.Reason = containerState(s)
		restarts += s.RestartCount
		n.Containers = append(n.Containers, cs)
		if initializing {
			continue
		}
		switch {
		case s.State.Terminated != nil && s.State.Terminated.ExitCode == 0:

		case s.State.Terminated != nil:
			initializing = true
			if s.State.Terminated.Reason != "" {
				reason = "Init:" + s.State.Terminated.Reason
			} else {
				reason = fmt.Sprintf("Init:ExitCode:%d", s.State.Terminated.ExitCode)
			}
		case s.State.Waiting != nil && s.State.Waiting.Reason != "" && s.State.Waiting.Reason != "PodInitializing":
			initializing = true
			reason = "Init:" + s.State.Waiting.Reason
		default:
			initializing = true
			reason = fmt.Sprintf("Init:%d/%d", i, len(p.Spec.InitContainers))
		}
	}
	hasRunning := false
	mains := make([]Container, len(p.Spec.Containers))
	for i := len(p.Spec.Containers) - 1; i >= 0; i-- {
		c := p.Spec.Containers[i]
		s := statusByName[c.Name]
		cs := Container{Name: c.Name, Image: c.Image, Restarts: s.RestartCount, Ready: s.Ready}
		cs.CPUReq, cs.MemReq = quantityString(c.Resources.Requests.Cpu()), quantityString(c.Resources.Requests.Memory())
		cs.State, cs.Reason = containerState(s)
		restarts += s.RestartCount
		mains[i] = cs
		if s.Ready {
			ready++
		}
		if initializing {
			continue
		}
		switch {
		case s.State.Waiting != nil && s.State.Waiting.Reason != "":
			reason = s.State.Waiting.Reason
		case s.State.Terminated != nil && s.State.Terminated.Reason != "":
			reason = s.State.Terminated.Reason
		case s.State.Terminated != nil:
			reason = fmt.Sprintf("ExitCode:%d", s.State.Terminated.ExitCode)
		case s.State.Running != nil && s.Ready:
			hasRunning = true
		}
	}

	n.Containers = append(n.Containers, mains...)

	if reason == "Completed" && hasRunning {
		if hasPodReadyCondition(p.Status.Conditions) {
			reason = "Running"
		} else {
			reason = "NotReady"
		}
	}
	if p.DeletionTimestamp != nil && p.Status.Reason == "NodeLost" {
		reason = "Unknown"
	} else if p.DeletionTimestamp != nil {
		reason = "Terminating"
	}
	n.Phase = reason
	n.Desired, n.Ready = int32(total), int32(ready)
	switch {
	case reason == "Running" && ready == total:
		n.Status = "ok"
	case reason == "Succeeded" || reason == "Completed":
		n.Status = "done"
	case reason == "Running", reason == "Pending", reason == "ContainerCreating", reason == "PodInitializing",
		reason == "Terminating", reason == "NotReady", strings.HasPrefix(reason, "Init:"):
		n.Status = "warn"
	default:
		n.Status = "error"
	}
	if n.Status == "warn" && strings.Contains(reason, "BackOff") {
		n.Status = "error"
	}
	n.Summary = fmt.Sprintf("%s · %d/%d ready · %d restarts", reason, ready, total, restarts)
	qos := string(p.Status.QOSClass)
	n.Facts = append(n.Facts,
		[2]string{"Node", p.Spec.NodeName},
		[2]string{"Pod IP", p.Status.PodIP},
		[2]string{"Host IP", p.Status.HostIP},
		[2]string{"QoS", qos},
		[2]string{"Service account", p.Spec.ServiceAccountName},
		[2]string{"Restarts", fmt.Sprint(restarts)},
	)
	if p.Status.StartTime != nil {
		n.Facts = append(n.Facts, [2]string{"Started", p.Status.StartTime.Format(time.RFC3339)})
	}
}

func containerState(s corev1.ContainerStatus) (string, string) {
	switch {
	case s.State.Running != nil:
		return "running", ""
	case s.State.Waiting != nil:
		return "waiting", s.State.Waiting.Reason
	case s.State.Terminated != nil:
		r := s.State.Terminated.Reason
		if r == "" {
			r = fmt.Sprintf("ExitCode:%d", s.State.Terminated.ExitCode)
		}
		return "terminated", r
	}
	return "unknown", ""
}

func hasPodReadyCondition(conditions []corev1.PodCondition) bool {
	for _, c := range conditions {
		if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
			return true
		}
	}
	return false
}

func (w *Watcher) pollMetrics(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	failures := 0
	for {
		list, err := w.metrics.MetricsV1beta1().PodMetricses(w.namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			failures++
			if failures == 1 {
				log.Printf("metrics.k8s.io unavailable (%v); CPU glow disabled until it answers", err)
			}
			if failures > 3 {

				select {
				case <-ctx.Done():
					return
				case <-time.After(2 * time.Minute):
				}
				continue
			}
		} else {
			failures = 0
			sample := MetricsSample{Time: time.Now()}
			for _, pm := range list.Items {
				m := PodMetrics{Target: nodeID("Pod", pm.Namespace, pm.Name)}
				for _, c := range pm.Containers {
					m.CPUMilli += c.Usage.Cpu().MilliValue()
					m.MemBytes += c.Usage.Memory().Value()
				}
				if obj, ok, _ := w.lister.pods.GetByKey(pm.Namespace + "/" + pm.Name); ok {
					if p, ok := obj.(*corev1.Pod); ok {
						for _, c := range p.Spec.Containers {
							m.CPUReqMilli += c.Resources.Requests.Cpu().MilliValue()
							m.MemReqBytes += c.Resources.Requests.Memory().Value()
						}
					}
				}
				sample.Pods = append(sample.Pods, m)
			}
			w.publish(Message{Type: "metrics", Data: sample})
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
