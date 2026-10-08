package app

// Register before launching so shutdown cannot close SQLite beneath a queued
// maintenance worker, including one waiting for the purge's media lock.
func (a *App) launchMaintenance(fn func()) bool {
	done, ok := a.beginMaintenance()
	if !ok {
		return false
	}
	go func() { defer done(); fn() }()
	return true
}

func (a *App) beginMaintenance() (func(), bool) {
	a.maintenanceJobMu.Lock()
	defer a.maintenanceJobMu.Unlock()
	if a.maintenanceClosed || a.ctx.Err() != nil {
		return nil, false
	}
	a.maintenanceJobWG.Add(1)
	return a.maintenanceJobWG.Done, true
}
