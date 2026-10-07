// Package main is the kubectl-skyline plugin: the cluster as an explorable 3D space.
package main

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/spf13/pflag"
	"k8s.io/cli-runtime/pkg/genericclioptions"
	"k8s.io/client-go/kubernetes"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"

	"github.com/zdk/kubectl-skyline/internal/cluster"
	"github.com/zdk/kubectl-skyline/internal/server"
	"github.com/zdk/kubectl-skyline/web"
)

var version = "dev"

func main() {
	flags := pflag.NewFlagSet("kubectl-skyline", pflag.ExitOnError)
	flags.Usage = func() {
		fmt.Fprintf(os.Stderr, `kubectl skyline — wander through your cluster in 3D

Usage:
  kubectl skyline [flags]

Starts a local web server and opens the 3D cluster view. All namespaces are
shown unless -n/--namespace is given. The tool is read-only.

Flags:
`)
		flags.PrintDefaults()
	}
	listen := flags.String("listen", "127.0.0.1:9393", "address to serve the UI on")
	allowNonLoopback := flags.Bool("allow-non-loopback", false, "allow --listen on a non-loopback address (exposes cluster details without auth)")
	noOpen := flags.Bool("no-open", false, "do not open the browser automatically")
	noMetrics := flags.Bool("no-metrics", false, "do not poll metrics.k8s.io for CPU/memory glow")
	showVersion := flags.Bool("version", false, "print version and exit")
	cfg := genericclioptions.NewConfigFlags(true)
	cfg.AddFlags(flags)
	flags.Parse(os.Args[1:])

	if *showVersion {
		fmt.Println("kubectl-skyline", version)
		return
	}

	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		log.Fatalf("bad --listen %q: %v", *listen, err)
	}
	if ip := net.ParseIP(host); (ip == nil || !ip.IsLoopback()) && host != "localhost" && !*allowNonLoopback {
		log.Fatalf("refusing to listen on non-loopback %q without --allow-non-loopback", host)
	}

	restConfig, err := cfg.ToRESTConfig()
	if err != nil {
		log.Fatalf("kubeconfig: %v", err)
	}
	restConfig.QPS, restConfig.Burst = 50, 100
	restConfig.UserAgent = "kubectl-skyline/" + version
	client, err := kubernetes.NewForConfig(restConfig)
	if err != nil {
		log.Fatalf("client: %v", err)
	}
	var metrics metricsclient.Interface
	if !*noMetrics {
		metrics, _ = metricsclient.NewForConfig(restConfig)
	}
	raw, err := cfg.ToRawKubeConfigLoader().RawConfig()
	kubeContext := ""
	if err == nil {
		kubeContext = raw.CurrentContext
	}
	if cfg.Context != nil && *cfg.Context != "" {
		kubeContext = *cfg.Context
	}
	namespace := ""
	if cfg.Namespace != nil {
		namespace = *cfg.Namespace
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	watcher := cluster.New(client, metrics, kubeContext, namespace)
	go func() {
		if err := watcher.Run(ctx); err != nil {
			log.Fatalf("watch: %v", err)
		}
	}()

	webFS, err := fs.Sub(web.Files, ".")
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{
		Addr:              *listen,
		Handler:           server.Log(server.New(watcher, client, webFS, version).Handler()),
		ReadHeaderTimeout: 10 * time.Second,
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	url := "http://" + ln.Addr().String()
	if host == "localhost" {
		url = "http://localhost:" + fmt.Sprint(ln.Addr().(*net.TCPAddr).Port)
	}
	log.Printf("kubectl skyline %s serving %s (context %q, namespace %q)", version, url, kubeContext, orAll(namespace))
	if !*noOpen {
		go openBrowser(url)
	}
	go func() {
		<-ctx.Done()
		shutdown, c := context.WithTimeout(context.Background(), 2*time.Second)
		defer c()
		srv.Shutdown(shutdown)
	}()
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func orAll(ns string) string {
	if ns == "" {
		return "all"
	}
	return ns
}

func openBrowser(url string) {
	time.Sleep(300 * time.Millisecond)
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("open %s in your browser (%v)", url, err)
	}
}
