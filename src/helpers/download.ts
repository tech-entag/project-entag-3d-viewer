import axios from "axios";

async function fetchFileAndConvert(fileUrl: string) {
  try {
    // Step 1: Fetch the file using Axios
    const response = await axios.get(fileUrl, {
      responseType: "arraybuffer", // Fetch binary data
    });

    // Step 2: Extract metadata
    const contentType = response.headers["content-type"] || "application/octet-stream";
    const fileName = fileUrl.split("/").pop() || "downloaded_file";
    const lastModified = response.headers["last-modified"]
      ? new Date(response.headers["last-modified"]).getTime()
      : Date.now(); // Default to now if not provided

    // Step 3: Create a Blob from the response data
    const blob = new Blob([response.data], { type: contentType });

    // Step 4: Create a File object with the Blob
    const file = new File([blob], fileName, {
      type: contentType,
      lastModified: lastModified,
    });

    console.log("Mimicked File Object:", file);
    return file;
  } catch (error) {
    console.error("Error fetching or converting the file:", error);
    throw error;
  }
}

export { fetchFileAndConvert };