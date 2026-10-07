// Package server serves the embedded UI and the snapshot, SSE and detail APIs.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/yaml"

	"github.com/zdk/kubectl-skyline/internal/cluster"
)

type Server struct {
	watcher *cluster.Watcher
	client  kubernetes.Interface
	web     fs.FS
	version string
}

func New(w *cluster.Watcher, client kubernetes.Interface, web fs.FS, version string) *Server {
	return &Server{watcher: w, client: client, web: web, version: version}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.page("index.html"))
	mux.HandleFunc("GET /list", s.page("list.html"))
	mux.HandleFunc("GET /detail", s.page("detail.html"))
	mux.Handle("GET /", http.FileServerFS(s.web))
	mux.HandleFunc("GET /api/snapshot", s.snapshot)
	mux.HandleFunc("GET /api/events", s.events)
	mux.HandleFunc("GET /api/resource", s.resource)
	mux.HandleFunc("GET /api/object-events", s.objectEvents)
	mux.HandleFunc("GET /api/logs", s.logs)
	return mux
}

func (s *Server) page(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := fs.ReadFile(s.web, name)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		body := strings.ReplaceAll(string(data), "{{VERSION}}", s.version)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		io.WriteString(w, body)
	}
}

func (s *Server) snapshot(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(s.watcher.Snapshot())
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	ch, cancel := s.watcher.Subscribe()
	defer cancel()
	keepalive := time.NewTicker(20 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-keepalive.C:
			io.WriteString(w, ": keepalive\n\n")
			flusher.Flush()
		case m := <-ch:
			data, err := json.Marshal(m.Data)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", m.Type, data)
			flusher.Flush()
		}
	}
}

func parseID(id string) (kind, namespace, name string, ok bool) {
	parts := strings.SplitN(id, "/", 3)
	if len(parts) != 3 || parts[0] == "" || parts[2] == "" {
		return "", "", "", false
	}
	return parts[0], parts[1], parts[2], true
}

func (s *Server) resource(w http.ResponseWriter, r *http.Request) {
	kind, ns, name, ok := parseID(r.URL.Query().Get("id"))
	if !ok {
		http.Error(w, "bad id", 400)
		return
	}
	obj := s.watcher.Get(kind, ns, name)
	if obj == nil {
		http.Error(w, "not found", 404)
		return
	}
	obj = obj.DeepCopyObject()
	if acc, err := metaAccessor(obj); err == nil {
		acc.SetManagedFields(nil)
	}

	gvks, _, err := kubernetesScheme().ObjectKinds(obj)
	if err == nil && len(gvks) > 0 {
		obj.GetObjectKind().SetGroupVersionKind(gvks[0])
	}
	data, err := yaml.Marshal(obj)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}

func (s *Server) objectEvents(w http.ResponseWriter, r *http.Request) {
	kind, ns, name, ok := parseID(r.URL.Query().Get("id"))
	if !ok {
		http.Error(w, "bad id", 400)
		return
	}
	evs := s.watcher.EventsFor(kind, ns, name)
	if evs == nil {
		evs = []cluster.Event{}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(evs)
}

func (s *Server) logs(w http.ResponseWriter, r *http.Request) {
	kind, ns, name, ok := parseID(r.URL.Query().Get("id"))
	if !ok || kind != "Pod" {
		http.Error(w, "bad id", 400)
		return
	}
	tail := int64(200)
	if t, err := strconv.ParseInt(r.URL.Query().Get("tail"), 10, 64); err == nil && t > 0 && t <= 5000 {
		tail = t
	}
	opts := &corev1.PodLogOptions{TailLines: &tail, Timestamps: true}
	if c := r.URL.Query().Get("container"); c != "" {
		opts.Container = c
	}
	if r.URL.Query().Get("previous") == "1" {
		opts.Previous = true
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	stream, err := s.client.CoreV1().Pods(ns).GetLogs(name, opts).Stream(ctx)
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	defer stream.Close()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	io.Copy(w, stream)
}

func metaAccessor(obj runtime.Object) (metav1.Object, error) {
	acc, ok := obj.(metav1.Object)
	if !ok {
		return nil, fmt.Errorf("no metadata")
	}
	return acc, nil
}

func Log(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			log.Printf("%s %s", r.Method, r.URL.RequestURI())
		}
		next.ServeHTTP(w, r)
	})
}
