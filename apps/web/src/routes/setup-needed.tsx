/**
 * /setup-needed — first-boot wizard. Lets the operator set the
 * dashboard password before any other route is reachable. Posts to
 * /api/auth/change-password (current = '' on first boot).
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";

function SetupNeeded() {
    const navigate = useNavigate();
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");

    const submit = useMutation({
        mutationFn: (pwd: string) =>
            api.post("/api/auth/change-password", { current: "", next: pwd }),
        onSuccess: () => navigate({ to: "/login" }),
    });

    const mismatch = confirm.length > 0 && confirm !== password;

    return (
        <div className="min-h-full flex items-center justify-center p-6">
            <form
                className="bg-tg-panel rounded-lg p-6 w-full max-w-md space-y-4"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (!mismatch && password.length >= 8) submit.mutate(password);
                }}
            >
                <div>
                    <h1 className="text-xl font-semibold">Welcome</h1>
                    <p className="text-sm text-tg-text-secondary mt-1">
                        Set a dashboard password to continue. Minimum 8 characters.
                    </p>
                </div>

                <input
                    type="password"
                    autoFocus
                    placeholder="New password"
                    className="w-full bg-black/30 rounded px-3 py-2 text-sm border border-white/10"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                />
                <input
                    type="password"
                    placeholder="Confirm password"
                    className="w-full bg-black/30 rounded px-3 py-2 text-sm border border-white/10"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                />
                {mismatch && (
                    <p className="text-red-400 text-sm">Passwords don't match.</p>
                )}
                <button
                    type="submit"
                    disabled={submit.isPending || mismatch || password.length < 8}
                    className="w-full px-3 py-2 bg-tg-blue rounded text-white disabled:opacity-50"
                >
                    {submit.isPending ? "Saving…" : "Save and continue"}
                </button>
                {submit.isError && (
                    <p className="text-red-400 text-sm">
                        {(submit.error as Error).message}
                    </p>
                )}
            </form>
        </div>
    );
}

export const Route = createFileRoute("/setup-needed")({
    component: SetupNeeded,
});
