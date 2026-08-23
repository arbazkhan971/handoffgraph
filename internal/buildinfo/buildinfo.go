// Package buildinfo provides the version reported by every HandoffGraph
// interface (CLI help, the version command, and MCP server metadata).
package buildinfo

import (
	"runtime/debug"
	"strings"
)

const developmentVersion = "dev"

// version is set by release builds with:
//
//	-X github.com/handoffgraph/handoffgraph/internal/buildinfo.version=<version>
//
// Keeping the fallback generic avoids shipping a stale product version from
// an ordinary source build. For binaries installed from a tagged Go module,
// Version falls back to the module version recorded by the Go toolchain.
var version = developmentVersion

// Version returns a normalized build version. Release and module versions
// include the conventional leading "v"; untagged source builds report "dev".
func Version() string {
	if normalized := normalize(version); normalized != developmentVersion {
		return normalized
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		return normalize(info.Main.Version)
	}
	return developmentVersion
}

func normalize(value string) string {
	value = strings.TrimSpace(value)
	switch value {
	case "", "(devel)", developmentVersion:
		return developmentVersion
	}
	if strings.HasPrefix(value, "v") {
		return value
	}
	return "v" + value
}
