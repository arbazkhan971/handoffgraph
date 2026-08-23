package buildinfo

import "testing"

func TestNormalize(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "empty", input: "", want: developmentVersion},
		{name: "go development marker", input: "(devel)", want: developmentVersion},
		{name: "development", input: "dev", want: developmentVersion},
		{name: "tagged module", input: "v0.7.0", want: "v0.7.0"},
		{name: "release injection", input: "0.7.0", want: "v0.7.0"},
		{name: "prerelease", input: " 0.7.0-alpha.1 ", want: "v0.7.0-alpha.1"},
		{name: "pseudo version", input: "v0.0.0-20260823010101-deadbeef1234", want: "v0.0.0-20260823010101-deadbeef1234"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := normalize(tt.input); got != tt.want {
				t.Fatalf("normalize(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestVersionDevelopmentBuild(t *testing.T) {
	// `go test` records the main package as command-line-arguments or a
	// development module, so the public result must never claim an old release.
	if got := Version(); got != developmentVersion {
		t.Fatalf("Version() = %q, want %q for a development build", got, developmentVersion)
	}
}
