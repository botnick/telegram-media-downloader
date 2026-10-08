package telegram

import (
	"context"
	"fmt"

	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
)

// durableUpdateAPI commits difference payloads before gotd can acknowledge
// their cursors. In v0.115.0 channel OtherUpdates are dispatched asynchronously;
// a handler-only guard cannot protect that path. Re-delivery is idempotent.
type durableUpdateAPI struct {
	updates.API
	state  *UpdateState
	handle func(context.Context, tg.UpdatesClass) error
	onGap  func(int64)
}

func (a durableUpdateAPI) gap(ctx context.Context, channel int64) error {
	if a.onGap != nil {
		a.onGap(channel)
	}
	return a.state.guard(ctx, func() error { return fmt.Errorf("Telegram history recovery required for channel %d", channel) })
}

func (a durableUpdateAPI) accept(ctx context.Context, messages []tg.MessageClass, other []tg.UpdateClass, users []tg.UserClass, chats []tg.ChatClass, channel bool, pts int) error {
	list := make([]tg.UpdateClass, 0, len(messages)+len(other))
	for _, message := range messages {
		if channel {
			list = append(list, &tg.UpdateNewChannelMessage{Message: message, Pts: pts})
		} else {
			list = append(list, &tg.UpdateNewMessage{Message: message, Pts: pts})
		}
	}
	list = append(list, other...)
	if len(list) == 0 {
		return nil
	}
	return a.handle(ctx, &tg.Updates{Updates: list, Users: users, Chats: chats})
}

func (a durableUpdateAPI) UpdatesGetDifference(ctx context.Context, r *tg.UpdatesGetDifferenceRequest) (tg.UpdatesDifferenceClass, error) {
	result, err := a.API.UpdatesGetDifference(ctx, r)
	if err != nil {
		return nil, err
	}
	switch d := result.(type) {
	case *tg.UpdatesDifference:
		err = a.accept(ctx, d.NewMessages, d.OtherUpdates, d.Users, d.Chats, false, d.State.Pts)
	case *tg.UpdatesDifferenceSlice:
		err = a.accept(ctx, d.NewMessages, d.OtherUpdates, d.Users, d.Chats, false, d.IntermediateState.Pts)
	case *tg.UpdatesDifferenceTooLong:
		err = a.gap(ctx, 0)
	}
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (a durableUpdateAPI) UpdatesGetChannelDifference(ctx context.Context, r *tg.UpdatesGetChannelDifferenceRequest) (tg.UpdatesChannelDifferenceClass, error) {
	result, err := a.API.UpdatesGetChannelDifference(ctx, r)
	if err != nil {
		return nil, err
	}
	switch d := result.(type) {
	case *tg.UpdatesChannelDifference:
		err = a.accept(ctx, d.NewMessages, d.OtherUpdates, d.Users, d.Chats, true, d.Pts)
	case *tg.UpdatesChannelDifferenceTooLong:
		channel, ok := r.Channel.(*tg.InputChannel)
		if !ok {
			return nil, fmt.Errorf("unexpected recovery channel %T", r.Channel)
		}
		err = a.gap(ctx, channel.ChannelID)
	}
	if err != nil {
		return nil, err
	}
	return result, nil
}
