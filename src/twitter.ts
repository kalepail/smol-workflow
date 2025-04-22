import { fetcher } from "itty-fetcher";

export const twitter = fetcher({ base: 'https://api.twitter.com/2' });

// TODO accept tweaks for music and image style
// TODO if a tweet is larger than default it gets truncated
    // Consider getting the whole tweet if needed
    // There's probably some limit for the downstream AI but we can cross that bridge when we get there??

// TODO support a version of this where folks can just send messages to the account vs having to seed it via a reply

export async function processTwitterMentions(env: Env, ctx: ExecutionContext) {
    const doid = env.DO_STATE.idFromName('SMOL ; March 2025');
    const stub = env.DO_STATE.get(doid);
    const latestTweet = await stub.getLatestTweet();

    const params = new URLSearchParams({
        "query": "@smolxyz -is:retweet (is:reply OR is:quote)",
        "tweet.fields": ['article', 'attachments', 'author_id', 'card_uri', 'community_id', 'conversation_id', 'created_at', 'entities', 'id', 'in_reply_to_user_id', 'media_metadata', 'note_tweet', 'referenced_tweets', 'reply_settings', 'scopes', 'source', 'text'].join(),
        "expansions": ['article.cover_media', 'article.media_entities', 'attachments.media_keys', 'attachments.media_source_tweet', 'author_id', 'in_reply_to_user_id', 'referenced_tweets.id', 'referenced_tweets.id.attachments.media_keys', 'referenced_tweets.id.author_id'].join(),
        "media.fields": ['alt_text', 'duration_ms', 'media_key', 'preview_image_url', 'type', 'url', 'variants'].join(),
        "max_results": "100",
        "sort_order": "recency"
    });

    if (latestTweet) {
        params.set('since_id', latestTweet);
    }

    const search: any = await twitter.get('/tweets/search/recent', params, {
        headers: {
            'Authorization': `Bearer ${env.TWITTER_BEARER_TOKEN}`,
        }
    });

    if (search.meta.result_count === 0) {
        console.log('No new mentions');
        return;
    }

    // console.log(search);

    for (const tweet of search?.data) {
        const prompt = search?.includes?.tweets?.find(({ id }: any) => id === tweet.referenced_tweets?.[0]?.id)?.text
        const author = search?.includes?.users?.find(({ id }: any) => id === tweet.author_id)?.username

        if (!prompt) {
            console.log('No prompt found');
            continue;
        }

        if (!author) {
            console.log('No author found');
            continue;
        }

        const instanceId = env.DURABLE_OBJECT.newUniqueId().toString();
        const instance = await env.WORKFLOW.create({
        	id: instanceId,
        	params: {
                tweet_id: tweet.id,
                tweet_author: author,
        		prompt,
        	}
        });

        console.log('Workflow started', instanceId, await instance.status());

        await stub.setLatestTweet(tweet.id);
    }
}