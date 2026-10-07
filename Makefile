VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build install test run clean

build:
	go build -ldflags '$(LDFLAGS)' -o bin/kubectl-skyline ./cmd/kubectl-skyline

install:
	go install -ldflags '$(LDFLAGS)' ./cmd/kubectl-skyline

test:
	go vet ./...
	go test ./...
	node --test web/test/*.test.mjs

run: build
	./bin/kubectl-skyline

clean:
	rm -rf bin dist
