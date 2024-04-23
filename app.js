const fs = require('fs');

const fetch = require('node-fetch');
var htmlEncodingSniffer = require("html-encoding-sniffer");
const whatwgEncoding = require("whatwg-encoding");
const cheerio = require("cheerio");

const RSSParser = require('rss-parser');
let rssParser = new RSSParser();
const RSS = require('rss');

config = require('./config.json')

async function extractComments(url){
    let html = '';
    try{
        let res = await fetch(url, {headers: {'User-Agent': 'facebookexternalhit'}});
        let buf = Buffer.from(await res.arrayBuffer());
        html = whatwgEncoding.decode(buf, htmlEncodingSniffer(buf, {defaultEncoding: 'UTF-8'}));
    }
    catch(e){
    }
    const $ = cheerio.load(html);
    if($('.comment_thread').length){
        let comments = JSON.parse($('.comment_thread').first().attr('data-json'));
        return comments
    }
}

function filterComments(comments, threshold = 200){
    let filtered = [];
    if(comments?.length){
        for(let comment of comments){
            if(comment.vote_total > threshold){
                filtered.push(comment);
            }
            filtered = filtered.concat(filterComments(comment.children));
        }
    }
    return filtered;
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

fetchPosts(feed, olderThan=config.olderThan, newerThan=config.newerThan).then(async posts => {
    for(let post of posts){
        await extractComments(post.link)
        .then(comments => filterComments(comments, config.threshold))
        .then(comments => {
            for(let comment of comments){
                let urlComment = addCommentID(stripUtm(post.link), comment.id);
                let item = {
                    url: urlComment, 
                    title: "Comment on " + post.title + " by " + comment.author,
                    description:  comment.content
                                + "<hr/>" 
                                + `<p>Comment URL: <a href=\"${urlComment}\">${urlComment}</a></p>`
                                + `<p>Post URL: <a href=\"${post.link}\">${post.link}</a></p>`
                                + `<p>Votes: ${comment.updoots}⬆ ${comment.downboops}⬇</p>`,
                    date: new Date(comment.date + "-04:00"),
                    author: comment.author,
                };
                outputFeed.item(item);
            }
        })
    }
}).then(() => {
    fs.writeFile('build/index.xml', outputFeed.xml(), function (err) {
        if (err) return console.log(err);});
});