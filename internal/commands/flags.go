package commands

import "flag"

// boolFlag returns the value of boolean flag name, or false when the flag is
// absent or its value is not a bool.
func boolFlag(fs *flag.FlagSet, name string) bool {
	f := fs.Lookup(name)
	if f == nil {
		return false
	}
	g, ok := f.Value.(flag.Getter)
	if !ok {
		return false
	}
	v, ok := g.Get().(bool)
	return ok && v
}

// stringFlag returns the value of string flag name, or "" when the flag is
// absent or its value is not a string.
func stringFlag(fs *flag.FlagSet, name string) string {
	f := fs.Lookup(name)
	if f == nil {
		return ""
	}
	g, ok := f.Value.(flag.Getter)
	if !ok {
		return ""
	}
	v, _ := g.Get().(string)
	return v
}
