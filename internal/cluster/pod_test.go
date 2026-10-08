package cluster

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
)

// Two init containers plus two main containers used to panic.
func TestFillPodKeepsAllContainers(t *testing.T) {
	p := &corev1.Pod{Spec: corev1.PodSpec{
		InitContainers: []corev1.Container{{Name: "i1"}, {Name: "i2"}},
		Containers:     []corev1.Container{{Name: "a"}, {Name: "b"}},
	}}
	n := &Node{}
	fillPod(n, p)

	want := []string{"i1", "i2", "a", "b"}
	if len(n.Containers) != len(want) {
		t.Fatalf("got %d containers, want %d", len(n.Containers), len(want))
	}
	for i, name := range want {
		if n.Containers[i].Name != name {
			t.Errorf("container %d = %q, want %q", i, n.Containers[i].Name, name)
		}
	}
}
