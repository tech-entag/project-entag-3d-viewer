// import axios from 'axios';
import axios from 'axios';

// export const config = {
//   runtime: 'nodejs', // this is a pre-requisite
// };

export function GET() {
  return new Response(`Hello from ${process.env.VERCEL_REGION}`);
}

export async function POST(req: Request) {
  console.log('req', req)

  const { part_id, version, image, urn } = JSON.parse(await req.text())

  const imageSubmit = await axios.post(
    `https://entag-10502.bubbleapps.io/version-${version}/api/1.1/wf/create_3d_preview`,
    {
      part_id,
      image: image,
      private: false,
      version,
      urn
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer bae073c7b9b6abf8d88992dd8fffc7c3`
      }
    }
  )

  return Response.json(imageSubmit.data)
}