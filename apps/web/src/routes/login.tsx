/**
 * /login — password entry. Submits to POST /api/login; the server
 * sets a tgdl_session cookie on success and the SPA navigates back
 * to '/'.
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";

interface LoginResp {
    role: "admin" | "guest";
}

function Login() {
    const navigate = useNavigate();
    const [password, setPassword] = useState("");

    const submit = useMutation({
        mutationFn: (pwd: string) => api.post<LoginResp>("/api/login", { password: pwd }),
        onSuccess: () => {
            navigate({ to: "/" });
        },
    });

    return (
        <div className="min-h-full flex items-center justify-center p-6">
            <form
                className="bg-tg-panel rounded-lg p-6 w-full max-w-sm space-y-4"
                onSubmit={(e) => {
                    e.preventDefault();
                    submit.mutate(password);
                }}
            >
                <h1 className="text-xl font-semibold">Sign in</h1>
                <input
                    type="password"
                    autoFocus
                    autoComplete="current-password"
                    placeholder="Dashboard password"
                    className="w-full bg-black/30 rounded px-3 py-2 text-sm border border-white/10"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                />
                <button
                    type="submit"
                    disabled={submit.isPending || !password}
                    className="w-full px-3 py-2 bg-tg-blue rounded text-white disabled:opacity-50"
                >
                    {submit.isPending ? "Signing in…" : "Sign in"}
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

export const Route = createFileRoute("/login")({
    component: Login,
});
