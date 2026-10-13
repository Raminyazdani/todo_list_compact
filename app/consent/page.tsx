import { redirect } from "next/navigation";
import { getConsentDetails } from "@/server/auth/consent";
import { getOwnerSession } from "@/server/auth/principal";
import Consent from "@/components/consent";
export const dynamic = "force-dynamic";
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const values = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else if (value !== undefined) params.set(key, value);
  }
  const details = await getConsentDetails(params.toString());
  if (!details)
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>درخواست اتصال معتبر نیست.</h1>
          <p>
            The authorization request is invalid or expired. Restart the
            connection from your MCP client.
          </p>
        </section>
      </main>
    );
  if (!(await getOwnerSession())) redirect(`/sign-in?${params}`);
  return <Consent details={details} />;
}
