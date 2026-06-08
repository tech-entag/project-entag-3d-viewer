const url = "https://project-entag-3d-viewer.vercel.app/api/autodesk?x-vercel-protection-bypass=qlQfStfLPXLfXBliB9xoS9FQFjMxys1V";
const body = {
  url: "https://e799e59cf1a17ec1dc9aca7d16738397.cdn.bubble.io/f1775667672430x287967715949301700/cutting-blade-1-k110-1.STEP",
  part_id: "1775667677542x346215801716720260",
  version: "test",
  client_id: "kDxg3ByzdMPW4xZC6dGp2aTqB4rCRiDOW5R2qjbDnPwaKbK9",
  client_secret: "oYVx7xu3iDckyS6yQY1dddNcOeu6LnHcayGDebWpumzjF8f5soed1t0Tznd4pKHH"
};
fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => {
    const t = await r.text();
    console.log("STATUS", r.status);
    console.log(t.slice(0, 4000));
  })
  .catch((e) => { console.error("ERR", e.message); process.exit(1); });
