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

function commentsToList(comments){
    let l = []
    for(let comment of comments){
        l.push(comment)
        if(comment.children){
            l = l.concat(commentsToList(comment.children))
        }
    }
    return l
}

function filterComments(comments, threshold = 200, topK=3, include=[], excludeUser=[]){
    let thresholded = comments?.length ? 
        comments.filter(comment => 
            comment.vote_total >= threshold && 
            !excludeUser.some(user => comment.author.toLowerCase().includes(user.toLowerCase()))) : 
        []
    if(thresholded.length > topK && topK > 0){
        let t =  thresholded.sort((a,b) => b.vote_total-a.vote_total).slice(0, topK)[topK-1].vote_total
        return thresholded.filter( 
            comment => comment.vote_total >= t || 
            (include.length && comment.vote_total >= threshold && comment.content.match(RegExp(`\\b(${include.join('|')})\\b`, 'gi')))
        )
    }
    return thresholded;
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
    for(let post of posts){
        await extractComments(post.link)
        .then(commentsToList)
        .then(comments => filterComments(comments, config.threshold, config.topK, config.include, config.excludeUser))
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
                    date: new Date(comment.date + config.timezone),
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