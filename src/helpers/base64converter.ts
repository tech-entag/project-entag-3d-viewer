async function convertImageToBase64(blobUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Fetch the blob data from the blob URL
    fetch(blobUrl)
      .then(response => response.blob())
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = error => reject(error);
        reader.readAsDataURL(blob); // Convert blob to Base64
      })
      .catch(error => reject(`Failed to fetch blob URL: ${error.message}`));
  });
}

export {
  convertImageToBase64
}

export async function convertBlobToImageFile(blobUrl: string, fileName: string): Promise<File> {
  return new Promise((resolve, reject) => {
    fetch(blobUrl)
      .then(response => response.blob())
      .then(blob => {
        const file = new File([blob], fileName, { type: blob.type });
        resolve(file);
      })
      .catch(error => reject(`Failed to convert blob to image file: ${error.message}`));
  });
}