package download

import (
	"github.com/botnick/telegram-media-downloader/core-service/internal/filepublish"
	"os"
)

func publishExclusiveAt(dir *os.File, from, to string) error {
	return filepublish.ExclusiveAt(dir, from, to)
}
