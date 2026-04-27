"""
批量把 handles 加到 Twitter List (via GraphQL)
依赖 openclaw profile 的 cookies (ct0 + auth_token)。
"""
import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:18800"
BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"

# GraphQL ops (from twitter-api-client constants, maintained upstream)
OP_USER_BY_SCREEN_NAME = ("sLVLhk0bGj3MVFEKTdax1w", "UserByScreenName")
OP_LIST_ADD_MEMBER = ("P8tyfv2_0HzofrB5f6_ugw", "ListAddMember")

# Features flags commonly required. Keep minimal set that UserByScreenName accepts.
UBSN_FEATURES = {
    "hidden_profile_likes_enabled": True,
    "hidden_profile_subscriptions_enabled": True,
    "responsive_web_graphql_exclude_directive_enabled": True,
    "verified_phone_label_enabled": False,
    "subscriptions_verification_info_is_identity_verified_enabled": True,
    "subscriptions_verification_info_verified_since_enabled": True,
    "highlights_tweets_tab_ui_enabled": True,
    "responsive_web_twitter_article_notes_tab_enabled": True,
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "responsive_web_graphql_timeline_navigation_enabled": True,
}
UBSN_FIELD_TOGGLES = {"withAuxiliaryUserLabels": False}

def get_cookies():
    with sync_playwright() as p:
        b = p.chromium.connect_over_cdp(CDP)
        ctx = b.contexts[0]
        c = {x["name"]: x["value"] for x in ctx.cookies("https://x.com")}
        return c

def _req(url, headers, method="GET", body=None):
    data = body.encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=20)
        return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return 0, f"EXC:{type(e).__name__}:{e}"

def _headers(cookies):
    return {
        "authorization": f"Bearer {BEARER}",
        "cookie": "; ".join(f"{k}={v}" for k, v in cookies.items()),
        "x-csrf-token": cookies.get("ct0", ""),
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-client-language": "en",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
        "origin": "https://x.com",
        "referer": "https://x.com/",
        "content-type": "application/json",
    }

def lookup_user_id(screen_name, cookies):
    qid, op = OP_USER_BY_SCREEN_NAME
    variables = {"screen_name": screen_name, "withSafetyModeUserFields": True}
    params = {
        "variables": json.dumps(variables, separators=(",", ":")),
        "features": json.dumps(UBSN_FEATURES, separators=(",", ":")),
        "fieldToggles": json.dumps(UBSN_FIELD_TOGGLES, separators=(",", ":")),
    }
    url = f"https://x.com/i/api/graphql/{qid}/{op}?" + urllib.parse.urlencode(params)
    status, body = _req(url, _headers(cookies))
    if status != 200:
        return None, f"{status}:{body[:200]}"
    try:
        j = json.loads(body)
        uid = j["data"]["user"]["result"]["rest_id"]
        return uid, None
    except Exception as e:
        return None, f"parse_err:{e}:{body[:200]}"

def add_to_list(list_id, user_id, cookies):
    qid, op = OP_LIST_ADD_MEMBER
    payload = {
        "variables": {
            "listId": list_id,
            "userId": user_id,
            "withSuperFollowsUserFields": True,
            "withDownvotePerspective": False,
            "withReactionsMetadata": False,
            "withReactionsPerspective": False,
            "withSuperFollowsTweetFields": True,
        },
        "features": {
            "rweb_lists_timeline_redesign_enabled": True,
            "responsive_web_graphql_exclude_directive_enabled": True,
            "verified_phone_label_enabled": False,
            "creator_subscriptions_tweet_preview_api_enabled": True,
            "responsive_web_graphql_timeline_navigation_enabled": True,
            "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
            "tweetypie_unmention_optimization_enabled": True,
            "responsive_web_edit_tweet_api_enabled": True,
            "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
            "view_counts_everywhere_api_enabled": True,
            "longform_notetweets_consumption_enabled": True,
            "responsive_web_twitter_article_tweet_consumption_enabled": False,
            "tweet_awards_web_tipping_enabled": False,
            "freedom_of_speech_not_reach_fetch_enabled": True,
            "standardized_nudges_misinfo": True,
            "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
            "longform_notetweets_rich_text_read_enabled": True,
            "longform_notetweets_inline_media_enabled": True,
            "responsive_web_media_download_video_enabled": False,
            "responsive_web_enhance_cards_enabled": False,
        },
        "queryId": qid,
    }
    url = f"https://x.com/i/api/graphql/{qid}/{op}"
    status, body = _req(url, _headers(cookies), method="POST", body=json.dumps(payload))
    return status, body

def clean_handle(h):
    h = h.strip()
    if h.startswith("@"):
        h = h[1:]
    return h.split("/")[0]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list-id", required=True)
    ap.add_argument("--handles", nargs="*", default=[])
    ap.add_argument("--from-stdin", action="store_true")
    args = ap.parse_args()
    handles = [clean_handle(h) for h in args.handles if h.strip()]
    if args.from_stdin or (not handles and not sys.stdin.isatty()):
        for line in sys.stdin:
            h = clean_handle(line)
            if h:
                handles.append(h)
    seen = set()
    handles = [h for h in handles if not (h.lower() in seen or seen.add(h.lower()))]
    print(f"Target List: {args.list_id}")
    print(f"Handles ({len(handles)}): {', '.join(handles)}\n")

    cookies = get_cookies()
    if "ct0" not in cookies or "auth_token" not in cookies:
        print("ERR: no auth cookies in openclaw profile", file=sys.stderr)
        sys.exit(2)

    log_path = Path.home() / f"Documents/Projects/twitter-digest/logs/list-add-{int(time.time())}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log = open(log_path, "w")

    results = {}
    for i, h in enumerate(handles, 1):
        print(f"[{i}/{len(handles)}] {h}", flush=True)
        uid, err = lookup_user_id(h, cookies)
        if not uid:
            r = f"lookup_fail:{err}"
            print(f"   ❌ {r}", flush=True)
            results[h] = r
            log.write(f"{h}\t{r}\n"); log.flush()
            continue
        print(f"   uid={uid}", flush=True)
        status, body = add_to_list(args.list_id, uid, cookies)
        snippet = body[:250].replace("\n", " ")
        if status == 200:
            try:
                j = json.loads(body)
                ok = j.get("data", {}).get("list", {}).get("members", {}) or j.get("data", {}).get("list")
                r = f"added (status 200)"
            except Exception:
                r = f"added?:{snippet}"
            print(f"   ✅ {r}", flush=True)
        else:
            r = f"http_{status}:{snippet}"
            print(f"   ❌ {r}", flush=True)
        results[h] = r
        log.write(f"{h}\t{r}\n"); log.flush()
        time.sleep(1.0)

    log.close()
    print(f"\nLog: {log_path}")
    print("\n=== Summary ===")
    ok_n = 0
    for h, r in results.items():
        mark = "✅" if r.startswith("added") else "❌"
        if r.startswith("added"): ok_n += 1
        print(f"  {mark} {h}: {r}")
    print(f"\n{ok_n}/{len(results)} added")

if __name__ == "__main__":
    main()
