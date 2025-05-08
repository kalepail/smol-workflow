const PIXELLAB_KEY = '8e3623e3-43e1-4699-a031-eb7fa7753f6a'

// TODO very probably need to run some sort of sentiment analysis on this to filter out NSFW stuff

export async function pixellab(description: string, model: 'pixflux' | 'bitforge') {
    let res: any

    if (!model || !description)
        throw new Error('Missing parameters')

    description = `
        ${description}.
        NOTE: Prefer rich scenes to characters and avatars.
    `

    switch (model) {
        case 'pixflux':
            res = await pixflux(description)
            break
        case 'bitforge':
            res = await bitforge(description)
            break
        default:
            throw new Error('Model not found')
    }

    return res.image.base64 as string
}

async function pixflux(description: string) {
    const width = 64
    // const width = 32

    return fetch('https://api.pixellab.ai/v1/generate-image-pixflux', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${PIXELLAB_KEY}`
        },
        body: JSON.stringify({
            description,
            negative_description: "blurry. dithering.",
            text_guidance_scale: 8, // max 20
            image_size: {
                width,
                height: width
            },
            outline: "selective outline",
            shading: "basic shading",
            detail: "medium detail",
            view: "low top-down",
            direction: "south",
            no_background: false
        })
    })
        .then(async (res) => {
            if (res.ok)
                return res.json()
            else
                throw await res.text()
        })
}

async function bitforge(description: string) {
    const width = 16

    return fetch('https://api.pixellab.ai/v1/generate-image-bitforge', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${PIXELLAB_KEY}`
        },
        body: JSON.stringify({
            description,
            negative_description: "blurry. dithering",
            text_guidance_scale: 8, // max 20
            coverage_percentage: 100 / width * 15,
            image_size: {
                width,
                height: width
            },
            outline: "selective outline",
            shading: "basic shading",
            detail: "medium detail",
            view: "low top-down",
            direction: "south",
            no_background: false
        })
    })
        .then(async (res) => {
            if (res.ok)
                return res.json()
            else
                throw await res.text()
        })
}