package cluster

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestHasResource(t *testing.T) {
	client := fake.NewSimpleClientset()
	w := New(client, nil, "test", "")
	if w.hasResource("batch/v1", "cronjobs") {
		t.Fatal("expected cronjobs to be missing on an empty cluster")
	}

	client.Resources = []*metav1.APIResourceList{{
		GroupVersion: "batch/v1",
		APIResources: []metav1.APIResource{{Name: "jobs"}, {Name: "cronjobs"}},
	}}
	if !w.hasResource("batch/v1", "cronjobs") {
		t.Fatal("expected cronjobs to be served")
	}
}
