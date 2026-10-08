package app

// Register before launching so shutdown cannot close SQLite beneath a queued
// maintenance worker, including one waiting for the purge's media lock.
func (a *App) launchMaintenance(fn func()) bool {
	a.maintenanceJobMu.Lock()
	defer a.maintenanceJobMu.Unlock()
	if a.maintenanceClosed || a.ctx.Err() != nil {
		return false
	}
	a.maintenanceJobWG.Add(1)
	go func() {
		defer a.maintenanceJobWG.Done()
		fn()
	}()
	return true
}
