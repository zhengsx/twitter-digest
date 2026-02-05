#!/usr/bin/env python3
"""
Twitter Browser Scrape Script
使用浏览器 CDP 协议抓取 Twitter 推文
"""

import json
import asyncio
import websockets
import re
from datetime import datetime, timedelta
from pathlib import Path
import time

# 用户列表
USERS = [
    "lexfridman", "LiorOnAI", "cjpedregal", "steph_palazzolo", "gdb",
    "indigox", "borgeaud_s", "dwarkesh_sp", "_The_Prophet__", "gregisenberg",
    "omarsar0", "onechancefreedm", "akshay_pachaar", "dair_ai", "rasbt",
    "chetaslua", "Thom_Wolf", "soumithchintala", "mattshumer_", "emollick",
    "michaeljburry", "JeffDean", "EpochAIResearch", "METR_Evals", "ilyasut",
    "karpathy", "OriolVinyalsML"
]

# 输出目录
OUTPUT_DIR = Path.home() / "Documents/Projects/twitter-digest/data/2026-02-05"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

def parse_time_text(time_text: str) -> datetime | None:
    """解析推文时间文本，如 '3小时前', '2月4日' 等"""
    now = datetime.now()
    
    # 匹配 "X小时前"
    if "小时前" in time_text:
        match = re.search(r'(\d+)', time_text)
        if match:
            hours = int(match.group(1))
            return now - timedelta(hours=hours)
    
    # 匹配 "X分钟前"
    if "分钟前" in time_text:
        match = re.search(r'(\d+)', time_text)
        if match:
            minutes = int(match.group(1))
            return now - timedelta(minutes=minutes)
    
    # 匹配 "Xh" 或 "Xm"
    if re.match(r'^\d+h$', time_text):
        hours = int(time_text[:-1])
        return now - timedelta(hours=hours)
    if re.match(r'^\d+m$', time_text):
        minutes = int(time_text[:-1])
        return now - timedelta(minutes=minutes)
    
    # 匹配日期格式 "2月4日" 
    match = re.search(r'(\d+)月(\d+)日', time_text)
    if match:
        month = int(match.group(1))
        day = int(match.group(2))
        year = now.year
        return datetime(year, month, day)
    
    return None

def is_within_24h(time_text: str) -> bool:
    """判断推文是否在24小时内"""
    parsed = parse_time_text(time_text)
    if parsed is None:
        # 如果无法解析，看是否包含明显过期的标记
        if "月" in time_text and "日" in time_text:
            # 解析日期
            match = re.search(r'(\d+)月(\d+)日', time_text)
            if match:
                month = int(match.group(1))
                day = int(match.group(2))
                today = datetime.now()
                tweet_date = datetime(today.year, month, day)
                return (today - tweet_date).days < 1
        return True  # 默认保留
    
    now = datetime.now()
    return (now - parsed).total_seconds() < 24 * 3600

print("Twitter Browser Scrape Script")
print(f"用户数: {len(USERS)}")
print(f"输出目录: {OUTPUT_DIR}")
