package app

func (a *App) beginForward(groupID string) func() {
	a.forwardActivityMu.Lock()
	if a.activeForwards == nil {
		a.activeForwards = make(map[string]int)
	}
	a.activeForwards[groupID]++
	a.forwardActivityMu.Unlock()
	return func() {
		a.forwardActivityMu.Lock()
		if a.activeForwards[groupID] <= 1 {
			delete(a.activeForwards, groupID)
		} else {
			a.activeForwards[groupID]--
		}
		a.forwardActivityMu.Unlock()
	}
}

func (a *App) lockForwardRouting(groupID string) (bool, func()) {
	a.forwardActivityMu.Lock()
	return a.activeForwards[groupID] > 0, a.forwardActivityMu.Unlock
}
