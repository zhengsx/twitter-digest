#!/bin/bash
# Crawl all 97 users in parallel batches of 10
cd ~/Documents/Projects/twitter-digest
OUTDIR="data/2026-02-07-v2"
mkdir -p "$OUTDIR"

JINA_KEY="jina_422c9ce559de4c519e827233cdcd90a0E22LcYJzishlFevVhkXkuuHXS_0G"

USERS=(LiorOnAI cjpedregal steph_palazzolo gdb indigox borgeaud_s dwarkesh_sp _The_Prophet__ gregisenberg omarsar0 onechancefreedm akshay_pachaar dair_ai rasbt chetaslua Thom_Wolf soumithchintala mattshumer_ emollick michaeljburry JeffDean EpochAIResearch METR_Evals sama elonmusk DarioAmodei karpathy demishassabis ylecun ilyasut danielgross jhyuxm Trinkle23897 NoamBrown markchen90 tom_brown Jasonwei20 lilianweng dpkingma AmandaAskell jackclarkSF janleike alexalbert__ OriolVinyals NandoDF hausman_k danijarh Quoc_Le RemiLeblond DrJimFan chelseafinn tri_dao percyliang hardmaru arankomatsuzaki seb_ruder swyx goodside hwchase17 mark_riedl RichardSocher SebastienBubeck npew MostafaRohani jacobaustin132 AlexTamkin FelixHill84 jackrae_ natfriedman _albertgu fchollet AndrewYNg GaryMarcus aidangomez arthurmensch sea_snell TonyZZhao alexwei_ SherylHsu02 andresnds caseychu9 joannejang josh_tobin_ billpeeb cmikeh2 rohanjamin _tim_brooks model_mechanic bcherny The_Whole_Daisy _catwu sammcallister Linatawfik9 YangsiboHuang vyraun xiao_ted xiaoyiz_uw)

TOTAL=${#USERS[@]}
BATCH=10
echo "Total users: $TOTAL"
echo "Start time: $(date)"

for ((i=0; i<TOTAL; i+=BATCH)); do
    BATCH_END=$((i+BATCH))
    if [ $BATCH_END -gt $TOTAL ]; then BATCH_END=$TOTAL; fi
    echo "--- Batch $((i/BATCH+1)): users $((i+1))-$BATCH_END ---"
    
    for ((j=i; j<BATCH_END; j++)); do
        USER="${USERS[$j]}"
        OUTFILE="$OUTDIR/${USER}.txt"
        if [ -f "$OUTFILE" ] && [ -s "$OUTFILE" ]; then
            echo "  [skip] $USER (already exists)"
            continue
        fi
        (
            curl -s -m 20 \
                -H "Authorization: Bearer $JINA_KEY" \
                -H "X-No-Cache: true" \
                "https://r.jina.ai/https://x.com/${USER}" > "$OUTFILE" 2>/dev/null
            SIZE=$(wc -c < "$OUTFILE" | tr -d ' ')
            echo "  [done] $USER (${SIZE} bytes)"
        ) &
    done
    wait
done

echo "End time: $(date)"
echo "Files:"
ls -la "$OUTDIR/" | head -5
echo "... total: $(ls "$OUTDIR/" | wc -l) files"
