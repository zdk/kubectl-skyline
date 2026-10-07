package server

import (
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/scheme"
)

func kubernetesScheme() *runtime.Scheme { return scheme.Scheme }
