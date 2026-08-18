import { Suspense } from "react";
import type { Metadata } from "next";
import LoginForm from "./LoginForm";

// Standalone sign-in screen (the request guard bounces every unauthenticated
// visit here). On a fresh install — no account yet — the same screen becomes
// the first-run "create the admin" form (cf. /api/auth/setup).
export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    // Suspense: LoginForm reads useSearchParams (the ?next= return path).
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
