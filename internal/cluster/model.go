// Package cluster watches a Kubernetes cluster and builds a graph snapshot of it.
package cluster

import "time"

type Snapshot struct {
	Context   string    `json:"context"`
	Generated time.Time `json:"generated"`
	Nodes     []*Node   `json:"nodes"`
	Edges     []Edge    `json:"edges"`
}

type Node struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	UID       string `json:"uid"`

	Status  string `json:"status"`
	Phase   string `json:"phase"`
	Summary string `json:"summary"`

	Owner string `json:"owner,omitempty"`

	ClusterNode string            `json:"clusterNode,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Containers  []Container       `json:"containers,omitempty"`
	Created     time.Time         `json:"created"`
	Facts       [][2]string       `json:"facts,omitempty"`

	Desired int32 `json:"desired,omitempty"`
	Ready   int32 `json:"ready,omitempty"`
}

type Container struct {
	Name     string `json:"name"`
	Image    string `json:"image"`
	State    string `json:"state"`
	Reason   string `json:"reason,omitempty"`
	Ready    bool   `json:"ready"`
	Restarts int32  `json:"restarts"`
	Init     bool   `json:"init,omitempty"`
	CPUReq   string `json:"cpuReq,omitempty"`
	MemReq   string `json:"memReq,omitempty"`
}

type Edge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Kind string `json:"kind"`
}

type Event struct {
	Target  string    `json:"target"`
	Type    string    `json:"type"`
	Reason  string    `json:"reason"`
	Message string    `json:"message"`
	Count   int32     `json:"count"`
	Time    time.Time `json:"time"`
}

type PodMetrics struct {
	Target   string `json:"target"`
	CPUMilli int64  `json:"cpuMilli"`
	MemBytes int64  `json:"memBytes"`

	CPUReqMilli int64 `json:"cpuReqMilli"`
	MemReqBytes int64 `json:"memReqBytes"`
}

type MetricsSample struct {
	Time time.Time    `json:"time"`
	Pods []PodMetrics `json:"pods"`
}
