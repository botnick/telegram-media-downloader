package telegram

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type MessageLink struct {
	ChatRef            string
	MessageID, TopicID int
}

var linkUsername = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{2,31}$`)

// ParseMessageLink only interprets Telegram addresses; it never fetches URLs.
// Private link IDs are MTProto IDs, converted by arithmetic to marked IDs.
func ParseMessageLink(input string) (MessageLink, error) {
	var result MessageLink
	input = strings.TrimSpace(input)
	if input == "" {
		return result, errors.New("Empty URL")
	}
	if strings.HasPrefix(input, "t.me/") || strings.HasPrefix(input, "telegram.me/") || strings.HasPrefix(input, "telegram.dog/") {
		input = "https://" + input
	}
	u, err := url.Parse(input)
	if err != nil || u.User != nil {
		return result, errors.New("Not a valid URL")
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return result, errors.New("Invalid Telegram URL parameters")
	}
	for _, key := range []string{"domain", "channel", "post", "thread", "comment"} {
		if len(q[key]) > 1 {
			return result, fmt.Errorf("Repeated Telegram URL parameter: %s", key)
		}
	}
	if q.Has("comment") {
		return result, errors.New("Discussion comment links are not supported; use the comment's own message link")
	}
	var username, channel, message, topic string
	switch u.Scheme {
	case "tg":
		action := u.Host
		if action == "" {
			action = u.Opaque
		}
		if u.Path != "" {
			return result, errors.New("Unknown tg:// URL")
		}
		switch action {
		case "resolve":
			username = q.Get("domain")
			if username == "" {
				return result, errors.New("tg://resolve missing domain")
			}
		case "privatepost":
			channel = q.Get("channel")
			if channel == "" {
				return result, errors.New("tg://privatepost missing channel")
			}
		default:
			return result, fmt.Errorf("Unsupported tg:// action: %s", action)
		}
		message, topic = q.Get("post"), q.Get("thread")
		if message == "" {
			return result, fmt.Errorf("tg://%s missing post", action)
		}
	case "http", "https":
		host := strings.ToLower(u.Host)
		if host != "t.me" && host != "telegram.me" && host != "telegram.dog" {
			return result, fmt.Errorf("Unsupported host: %s", host)
		}
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(parts) > 0 && parts[0] == "s" {
			parts = parts[1:]
		}
		if len(parts) < 2 {
			return result, errors.New("Telegram URL is missing the message id")
		}
		if parts[0] == "c" {
			if len(parts) < 3 {
				return result, errors.New("Private-channel URL must include a message id")
			}
			channel, parts = parts[1], parts[2:]
		} else {
			username, parts = parts[0], parts[1:]
		}
		if len(parts) > 2 {
			return result, errors.New("Unexpected Telegram URL path")
		}
		message = parts[len(parts)-1]
		if len(parts) == 2 {
			topic = parts[0]
		}
		if q.Has("thread") {
			if topic != "" && topic != q.Get("thread") {
				return result, errors.New("Conflicting Telegram topic IDs")
			}
			topic = q.Get("thread")
		}
	default:
		return result, errors.New("Not a valid Telegram URL")
	}
	if channel != "" {
		id, e := decimalID(channel, 999999999999)
		if e != nil {
			return result, errors.New("Invalid channel id")
		}
		result.ChatRef = strconv.FormatInt(-1000000000000-id, 10)
	} else {
		if !linkUsername.MatchString(username) {
			return result, errors.New("Invalid Telegram username")
		}
		result.ChatRef = "@" + username
	}
	id, err := decimalID(message, 2147483647)
	if err != nil {
		return MessageLink{}, errors.New("Invalid message id")
	}
	result.MessageID = int(id)
	if topic != "" || q.Has("thread") {
		id, err = decimalID(topic, 2147483647)
		if err != nil {
			return MessageLink{}, errors.New("Invalid topic id")
		}
		result.TopicID = int(id)
	}
	return result, nil
}

func decimalID(value string, max int64) (int64, error) {
	for _, c := range value {
		if c < '0' || c > '9' {
			return 0, errors.New("ID is not decimal")
		}
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n <= 0 || n > max {
		return 0, errors.New("ID is out of range")
	}
	return n, nil
}
