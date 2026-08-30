package commands

// collectStringFields recursively extracts string-valued fields from decoded
// TOML or JSON. Hook installer tests use it so assertions follow the parsed
// configuration instead of depending on provider-specific whitespace.
func collectStringFields(value any, key string) []string {
	var out []string
	switch typed := value.(type) {
	case map[string]any:
		for name, child := range typed {
			if name == key {
				if text, ok := child.(string); ok {
					out = append(out, text)
				}
			}
			out = append(out, collectStringFields(child, key)...)
		}
	case []any:
		for _, child := range typed {
			out = append(out, collectStringFields(child, key)...)
		}
	case []map[string]any:
		for _, child := range typed {
			out = append(out, collectStringFields(child, key)...)
		}
	}
	return out
}
