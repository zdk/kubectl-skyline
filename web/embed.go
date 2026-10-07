// Package web embeds the static UI.
package web

import "embed"

//go:embed *.html *.css *.js vendor/*
var Files embed.FS
