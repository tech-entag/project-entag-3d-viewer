// import {
//   initViewer,
//   listModels,
//   loadModel,
// } from "https://aps-codepen.autodesk.io/utils.js";

// const viewer = await initViewer(document.getElementById("viewer"), {
//   extensions: ["Autodesk.DocumentBrowser"],
// });
// const models = await listModels();
// const dropdown = document.getElementById("models");
// dropdown.innerHTML = models
//   .map((m) => `<option value="${m.urn}">${m.name}</option>`)
//   .join("");
// dropdown.onchange = () => dropdown.value && loadModel(viewer, dropdown.value);
// dropdown.onchange();
// viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, function () {
//   viewer.search("concrete", function (ids) {
//     viewer.isolate(ids);
//   });
// });
var viewer;
var options = {
  env: "AutodeskProduction2",
  api: "streamingV2", // for models uploaded to EMEA change this option to 'streamingV2_EU'
  getAccessToken: function (onTokenReady) {
    var token =
      "eyJhbGciOiJSUzI1NiIsImtpZCI6IlhrUFpfSmhoXzlTYzNZS01oRERBZFBWeFowOF9SUzI1NiIsInBpLmF0bSI6ImFzc2MifQ.eyJzY29wZSI6WyJ2aWV3YWJsZXM6cmVhZCJdLCJjbGllbnRfaWQiOiJCd1FZYzBOaGdhN1FLWkJ3NWdwVWhUdHVhT1ZpckE1RkZDVk1sMWpDQzBIcUpzSUEiLCJpc3MiOiJodHRwczovL2RldmVsb3Blci5hcGkuYXV0b2Rlc2suY29tIiwiYXVkIjoiaHR0cHM6Ly9hdXRvZGVzay5jb20iLCJqdGkiOiIyRkNCcEVEOGM5WUZ5OXJqVnl3RlRKV2VwZ3BzS1hERnRMREZXSndybXJrbEZITThWbjBoNG9CNWREMnJDdGFLIiwiZXhwIjoxNzMxNjQ3ODc1LCJ1c2VyaWQiOiI0RjYyWDNRMk1FUVNLWkRXIn0.SkrK9mN1XKCs2EiHvBffk3nF-Ri8H9E0S6DRGVrORW2GZMG_GaxRb75y9xg48K09Q1j9erRa80lJv9fievTYddum1H5mWD-W5U8Jizfwobcne3-qR_ZspmMN0Nk-NFrlBBxL7SNIA6wV_Q10idxNVJCL9jRs7VSpb2dB29ggaq1QyF_Id7VrwvMmXLH8ct9gdX4a3I1NfaIFpv0pyqnDsGKYKiPqxMjvrAl_x4NBFjq8-atLaiVzmaVZ0ACvisZBmB2rYgiAc0objNtNic4jBL5I5G1zoLEAQqAEw0aNe651ZiW9ti0h1fiLM_Kw2fEt_Mw_Ouy_QeRNFX5QyeYZug";
    var timeInSeconds = 3600; // Use value provided by APS Authentication (OAuth) API
    onTokenReady(token, timeInSeconds);
  },
};

Autodesk.Viewing.Initializer(options, function () {
  var htmlDiv = document.getElementById("viewer");
  viewer = new Autodesk.Viewing.GuiViewer3D(htmlDiv);
  var startedCode = viewer.start();
  console.log("htmlDiv ",htmlDiv);
  console.log("viewer ",viewer);
  console.log("startedCode ",startedCode);
  
  if (startedCode > 0) {
    console.error("Failed to create a Viewer: WebGL not supported.");
    return;
  }

  console.log("Initialization complete, loading a model next...");
});
