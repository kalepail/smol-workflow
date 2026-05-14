// TODO very probably need to run some sort of sentiment analysis on this to filter out NSFW stuff

export async function pixellab(env: Env, description: string, model: 'pixflux' | 'bitforge') {
    let res: any

    if (!model || !description)
        throw new Error('Missing parameters')

    if (!env.PIXELLAB_KEY) {
        throw new Error('Missing Pixellab API key')
    }

    // description = `
    //     A rich scene without any characters or people.
    //     ${description}.
    // `

    switch (model) {
        case 'pixflux':
            res = await pixflux(env, description)
            break
        case 'bitforge':
            res = await bitforge(env, description)
            break
        default:
            throw new Error('Model not found')
    }

    return res.image.base64 as string
}

async function pixflux(env: Env, description: string) {
    const width = 64
    // const width = 32

    return fetch('https://api.pixellab.ai/v1/generate-image-pixflux', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.PIXELLAB_KEY}`
        },
        body: JSON.stringify({
            description,
            negative_description: "blurry. dithering. photorealism.",
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

async function bitforge(env: Env, description: string) {
    const width = 16

    return fetch('https://api.pixellab.ai/v1/generate-image-bitforge', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.PIXELLAB_KEY}`
        },
        body: JSON.stringify({
            description,
            negative_description: "blurry. dithering. photorealism.",
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
