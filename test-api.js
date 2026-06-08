// import fetch from 'node-fetch'; // Built-in in Node 18+

// REPLACE THESE VALUES WITH YOUR ACTUAL DATA
const PAYLOAD = {
    url: "https://e799e59cf1a17ec1dc9aca7d16738397.cdn.bubble.io/f1740387279130x985282229686891500/Bearing%20608%20%281%29.SLDPRT",
    part_id: "1740387295335x194579568914510200",
    version: "version-test",
    client_id: "eOeBMKtAb5KaFS8DTsaS0z4RT4Ov8Jmohwd9O16iP03GNuZj",
    client_secret: "m7kWFv7Nd6W7fCPtPwAO60L6TadVcb2SAZVuFte9uVaDubWaYzZj34NPOArjl02B"
};

async function testApi() {
    try {
        console.log("Sending request to API...");
        const response = await fetch('http://localhost:5173/api/autodesk', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(PAYLOAD)
        });

        const data = await response.json();
        console.log("Response status:", response.status);
        console.log("Response data:", JSON.stringify(data, null, 2));

        if (!response.ok) {
            console.error("Test failed!");
        } else {
            console.log("Test passed!");
        }
    } catch (error) {
        console.error("Error running test:", error);
    }
}

testApi();
