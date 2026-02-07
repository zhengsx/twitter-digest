#!/usr/bin/env python3
"""Extract recent tweets (Feb 6-7, 2026) from crawled data and output a summary."""
import os
import re
import json

DATA_DIR = os.path.expanduser("~/Documents/Projects/twitter-digest/data/2026-02-07-v2")
OUTPUT_FILE = os.path.expanduser("~/Documents/Projects/twitter-digest/data/2026-02-07-v2/extracted_tweets.json")

# Date patterns to look for
DATE_PATTERNS = [
    r'Feb\s+[67],?\s+2026',
    r'February\s+[67],?\s+2026',
    r'2026-02-0[67]',
    r'2026年2月[67]日',
    r'[67]\s+Feb\s+2026',
    # Also look for relative time indicators (hours ago, etc.)
    r'\d+h\b',
    r'\d+\s*hour',
    r'\d+m\b',
    r'\d+\s*min',
    r'just now',
    r'yesterday',
]

results = {}
all_content = {}

for fname in sorted(os.listdir(DATA_DIR)):
    if not fname.endswith('.txt'):
        continue
    username = fname.replace('.txt', '')
    fpath = os.path.join(DATA_DIR, fname)
    
    with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()
    
    # Skip very small files (likely errors/empty profiles)
    if len(content) < 500:
        continue
    
    # Store all content for analysis
    all_content[username] = content

# Output all content sizes and first lines for inspection
summary = []
for username, content in sorted(all_content.items()):
    lines = content.strip().split('\n')
    # Get non-empty content lines (skip boilerplate)
    content_lines = []
    skip_patterns = ['Don\'t miss what', 'People on X', 'Log in', 'Sign up', 'New to X',
                     'personalized timeline', 'Create account', 'Terms of Service',
                     'Privacy Policy', 'Cookie', 'Trending', 'Show more', 'Footer',
                     '© 2026', 'Ads info', 'Accessibility']
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if any(p.lower() in line.lower() for p in skip_patterns):
            continue
        if line.startswith('![') or line.startswith('[Image'):
            continue
        content_lines.append(line)
    
    if len(content_lines) > 3:  # Has meaningful content
        summary.append({
            'username': username,
            'size': len(content),
            'content_lines': len(content_lines),
            'preview': '\n'.join(content_lines[:50])  # First 50 meaningful lines
        })

# Write summary
with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
    json.dump(summary, f, ensure_ascii=False, indent=2)

print(f"Processed {len(all_content)} users with content")
print(f"Output: {len(summary)} users with meaningful content")
print(f"Saved to: {OUTPUT_FILE}")

# Also create a combined text file for easier analysis
combined_file = os.path.join(DATA_DIR, "combined_all.txt")
with open(combined_file, 'w', encoding='utf-8') as f:
    for item in summary:
        f.write(f"\n{'='*60}\n")
        f.write(f"@{item['username']} ({item['size']} bytes, {item['content_lines']} lines)\n")
        f.write(f"{'='*60}\n")
        f.write(item['preview'])
        f.write('\n')

print(f"Combined file: {combined_file}")
print(f"Combined size: {os.path.getsize(combined_file)} bytes")
