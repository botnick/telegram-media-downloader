package app

// Config trees contain only JSON values. Recursing over them avoids exposing
// nested secrets or mutating the map used for persistence while redacting.
func cloneConfigValue(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, x := range v {
			out[k] = cloneConfigValue(x)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, x := range v {
			out[i] = cloneConfigValue(x)
		}
		return out
	default:
		return value
	}
}

func mergeConfig(target, patch map[string]any) {
	for key, value := range patch {
		if key == "__proto__" || key == "constructor" || key == "prototype" {
			continue
		}
		if incoming, ok := value.([]any); ok && (key == "groups" || key == "accounts") {
			existing, _ := target[key].([]any)
			byID := map[string]map[string]any{}
			for _, raw := range existing {
				if item, ok := raw.(map[string]any); ok {
					byID[toString(item["id"])] = item
				}
			}
			items := make([]any, 0, len(incoming))
			for _, raw := range incoming {
				item, ok := raw.(map[string]any)
				if !ok {
					items = append(items, cloneConfigValue(raw))
					continue
				}
				merged := map[string]any{}
				if old := byID[toString(item["id"])]; old != nil {
					merged = cloneConfigValue(old).(map[string]any)
				}
				mergeConfig(merged, item)
				delete(merged, "hasMonitorAccount")
				delete(merged, "hasForwardAccount")
				items = append(items, merged)
			}
			target[key] = items
			continue
		}
		if object, ok := value.(map[string]any); ok {
			current, ok := target[key].(map[string]any)
			if !ok {
				current = map[string]any{}
			}
			mergeConfig(current, object)
			target[key] = current
		} else {
			target[key] = cloneConfigValue(value)
		}
	}
}

func objectAt(config map[string]any, path ...string) map[string]any {
	for _, key := range path {
		config, _ = config[key].(map[string]any)
	}
	return config
}

var configSecrets = [][]string{
	{"telegram", "apiHash"}, {"web", "shareSecret"}, {"web", "guestPasswordHash"},
	{"proxy", "password"}, {"advanced", "nsfw", "apiToken"},
	{"advanced", "seekbar", "apiToken"}, {"advanced", "ai", "faces", "sidecarToken"},
}

func stripPresenceFlags(config map[string]any) {
	for _, path := range configSecrets {
		delete(objectAt(config, path[:len(path)-1]...), path[len(path)-1]+"Set")
	}
}

func redactConfig(config map[string]any) map[string]any {
	safe := cloneConfigValue(config).(map[string]any)
	for _, path := range configSecrets {
		block := objectAt(safe, path[:len(path)-1]...)
		if block == nil {
			continue
		}
		key := path[len(path)-1]
		value := block[key]
		block[key+"Set"] = value != nil && value != "" && value != false
		delete(block, key)
	}
	web := objectAt(safe, "web")
	delete(web, "password")
	delete(web, "passwordHash")
	if accounts, ok := safe["accounts"].([]any); ok {
		for i, raw := range accounts {
			account, _ := raw.(map[string]any)
			item := map[string]any{}
			for _, key := range []string{"id", "name", "username"} {
				if value, ok := account[key]; ok {
					item[key] = value
				}
			}
			accounts[i] = item
		}
	}
	if groups, ok := safe["groups"].([]any); ok {
		for _, raw := range groups {
			group, _ := raw.(map[string]any)
			for _, key := range []string{"monitorAccount", "forwardAccount"} {
				if value := group[key]; value != nil && value != "" {
					if key == "monitorAccount" {
						group["hasMonitorAccount"] = true
					} else {
						group["hasForwardAccount"] = true
					}
					delete(group, key)
				}
			}
		}
	}
	return safe
}
