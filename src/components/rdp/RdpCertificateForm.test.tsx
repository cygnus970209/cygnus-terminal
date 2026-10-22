import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import RdpCertificateForm from "./RdpCertificateForm";
import type { RdpCertificate } from "../../types/rdp";
const fingerprint=Array(32).fill("AB").join(":");
const certificate:RdpCertificate={type:"certificate",fingerprint,subject:"<script>server</script>",issuer:"Local",valid_from:"2026-01-01",valid_until:"2027-01-01"};
function render(saved?:string){return renderToStaticMarkup(<RdpCertificateForm certificate={{...certificate,saved_fingerprint:saved}} endpoint="host.test:3389" sessionId="test" onApprove={()=>{}} onForgotten={()=>{}}/>);}
describe("RDP certificate trust states",()=>{
 it("requires explicit opt-in to remember a first-use certificate and escapes server content",()=>{
  const html=render();expect(html).toContain("Verify this RDP server");expect(html).toContain("Remember this fingerprint");
  expect(html).not.toContain('checked=""');expect(html).toContain("Trust once &amp; connect");
  expect(html).not.toContain("<script>");expect(html).toContain("&lt;script&gt;");
 });
 it("reports a saved match without claiming certificate authority validation",()=>{
  const html=render(fingerprint);expect(html).toContain("Saved certificate matches");
  expect(html).toContain("does not automatically verify");expect(html).toContain("Forget saved certificate");
  expect(html).not.toContain("Remember this fingerprint");
 });
 it("blocks password entry and submission when a saved fingerprint changed",()=>{
  const old=Array(32).fill("CD").join(":");const html=render(old);
  expect(html).toContain("RDP certificate changed");expect(html).toContain(old);expect(html).toContain(fingerprint);
  expect(html).toMatch(/type="password"[^>]*disabled=""/);expect(html).toMatch(/type="submit"[^>]*disabled=""/);
  expect(html).toContain("I verified this changed fingerprint");expect(html).not.toContain('checked=""');
 });
});
