package engine

import "testing"

func TestOnlyOneServerCanRecoverTheSameLibrary(t *testing.T) {
	dir := t.TempDir()
	release, err := AcquireServerOwnership(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := AcquireServerOwnership(dir)
	if err == nil {
		second()
		release()
		t.Fatal("two servers own the same library")
	}
	release()
	third, err := AcquireServerOwnership(dir)
	if err != nil {
		t.Fatalf("lock survived owner exit: %v", err)
	}
	third()
}
