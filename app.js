const fs = require('fs');

const fetch = require('node-fetch');
var htmlEncodingSniffer = require("html-encoding-sniffer");
const whatwgEncoding = require("whatwg-encoding");
const cheerio = require("cheerio");

const RSSParser = require('rss-parser');
let rssParser = new RSSParser();
const RSS = require('rss');

config = require('./config.json')

async function getHTMLScraper(url){
    let endpoint = new URL(config.endpointScraper); 
    endpoint.searchParams.append("x-api-key", process.env.SCRAPER_API_KEY);
    endpoint.searchParams.append("url", url);
    endpoint.searchParams.append("browser", "false");
    let html = ''
    try{
        let res = await fetch(endpoint.href);
        let buf = Buffer.from(await res.arrayBuffer());
        html = whatwgEncoding.decode(buf, htmlEncodingSniffer(buf, {defaultEncoding: 'UTF-8'}));
    }
    catch(e){}
    return html;
}

async function extractComments(url){
    let html = '';
    try{
        html = await getHTMLScraper(url)
    }
    catch(e){
        console.log(e)
    }
    const $ = cheerio.load(html);
    if($('.comment_thread').length){
        let comments = JSON.parse($('.comment_thread').first().attr('data-json'));
        return comments
    }
    return [];
}

function commentsToList(comments){
    let l = []
    for(let comment of comments){
        l.push(comment)
        if(comment.children){
            l = l.concat(commentsToList(comment.children.map( c => { return {...c, parentAuthor: comment.author, parentContent: comment.content}} )))
        }
    }
    return l
}

function filterComments(comments, threshold = 200, topK=3, include=[], excludeUser=[]){
    let thresholded = comments?.length ? 
        comments.filter(comment => 
            comment.vote_total >= threshold && 
            !excludeUser.some(user => comment.author.toLowerCase().includes(user.toLowerCase()))
            ) : []
    if(thresholded.length > topK && topK > 0){
        let t =  thresholded.sort((a,b) => b.vote_total-a.vote_total).slice(0, topK)[topK-1].vote_total
        return thresholded.filter( 
            comment => comment.vote_total >= t || 
            (include.length && comment.vote_total >= threshold && comment.content.match(RegExp(`\\b(${include.join('|')})\\b`, 'gi')))
        )
    }
    return thresholded;
}

function calculateThreshold(voteData, threshold_min, threshold_max){
    let threshold = threshold_max

    let N  = voteData.length
    if(N > 1){
        let s  = voteData.reduce((a,b) => a+b)
        let ss = voteData.reduce((a,b) => a+b*b)
        let max_votes = voteData.reduce((a,b) => {if(a > b){return a} return b})
        let sd = Math.sqrt((1/(N-1))*(ss - ((s*s)/N)))
        let m  = s/N
        threshold = 0.5 * (max_votes + m + 3*sd)
        
        // clip threshold
        if(threshold < threshold_min){
            threshold = threshold_min
        }
        if(threshold > threshold_max){
            threshold = threshold_max
        }
    }
    return threshold
}

async function fetchPosts(feedUrl, olderThan=1, newerThan=2){
    let posts = []; 
    await rssParser.parseURL(feedUrl).then( async (feedContent) => {
        for (let entry of feedContent.items)
        {
            if ('pubDate' in entry){
                if( Date.now() - Date.parse(entry.pubDate) > 3600 * 24 * 1000 * olderThan && 
                    Date.now() - Date.parse(entry.pubDate) < 3600 * 24 * 1000 * newerThan ){
                    posts.push(entry);
                }
            }               
        }
    })
    return posts;
}

function stripUtm(url) {
    const parsedUrl = new URL(url);
    const params = new URLSearchParams(parsedUrl.search);
  
    const utmParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  
    utmParams.forEach(param => {
      if (params.has(param)) {
        params.delete(param);
      }
    });
    
    parsedUrl.search = params.toString();
    return parsedUrl.toString();
}

function addCommentID(url, commentID){
    const parsedUrl = new URL(url);
    const params = new URLSearchParams(parsedUrl.search);
    params.set("commentID", commentID);
    parsedUrl.search = params.toString();
    return parsedUrl.toString();
}

var feed = config.source;
let outputFeed = new RSS({title: config.title, feed_url: config.url, site_url: config.site});

fetchPosts(feed, config.olderThan, config.newerThan).then(async posts => {
    // collect posts and comments
    let postsAndComments = []
    for(let post of posts){
        let comment_list = await extractComments(post.link).then(commentsToList)
        postsAndComments.push({post, comment_list})
    }

    // calculate threshold (max + mean + 3*std)/2
    let voteData = postsAndComments.map(p => p.comment_list).flat().map(comment => comment.vote_total)
    let threshold = calculateThreshold(voteData, config.threshold_max, config.threshold_min)

    // filter comments by votes
    for(let p of postsAndComments){
        let post     = p.post
        let comments = p.comment_list
        filterComments(comments, threshold, config.topK, config.include, config.excludeUser)
        .forEach(comment => {
            let urlComment = addCommentID(stripUtm(post.link), comment.id);
            let item = {
                url: urlComment, 
                title: "Comment on " + post.title + " by " + comment.author,
                description:  (comment.parentAuthor ? `<p>Reply to ${comment.parentAuthor}:</p>` : '')
                            + (comment.parentContent ? `<blockquote>${comment.parentContent}</blockquote>` : '')
                            + comment.content
                            + "<hr/>" 
                            + `<p>Comment URL: <a href=\"${urlComment}\">${urlComment}</a></p>`
                            + `<p>Post URL: <a href=\"${post.link}\">${post.link}</a></p>`
                            + `<p>Votes: ${comment.updoots}⬆ ${comment.downboops}⬇</p>`,
                date: new Date(comment.date + config.timezone),
                author: comment.author,
            };
            outputFeed.item(item);
        })
    }
}).then(() => {
    fs.writeFile('build/index.xml', outputFeed.xml(), function (err) {
        if (err) return console.log(err);});
});