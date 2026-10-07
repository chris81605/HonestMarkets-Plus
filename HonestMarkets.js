(function () {
    "use strict";

    const HM = setup.HonestMarkets = setup.HonestMarkets || {};

    HM.config = Object.assign({
        minShown: 6,      // 每個商品分類預設最少顯示數量
        maxShown: 8,      // 每個商品分類預設最多顯示數量
        maxLot: 240,      // 單批商品預設最大數量
        shownMinLimit: 5, // 商品顯示數量設定的安全下限
        shownMaxLimit: 20,// 商品顯示數量設定的安全上限
        maxLotMin: 50,    // 最大批次設定的安全下限
        maxLotMax: 2500,  // 最大批次設定的安全上限
        priceMultiplier: 1,    // 全局 foodstuff 商品價值倍率預設值
        priceMultiplierMin: 1, // 商品價值倍率安全下限
        priceMultiplierMax: 50 // 商品價值倍率安全上限
    }, HM.config || {});

    /*
     * ==================== 玩家市場設定 ====================
     *
     * Options 介面只負責方便調整，不能視為資料安全邊界。
     * 玩家仍可能透過控制台、舊存檔或其他 Mod 寫入負數、極大值、NaN、Infinity 或字串。
     * 因此所有設定在「寫入」與「市場真正使用」時都會再次正規化。
     *
     * 一般商品數量：5～20，預設 6～8。
     * 最大批次 maxLot：50～2500，預設 240。
     * 這些值只在 beginVisit() 建立新市場時鎖入 visit；修改 Options 不會改動已生成市場。
     */
    HM.clampInteger = function (value, min, max, fallback) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, Math.round(n)));
    };

    HM.getMarketSettings = function () {
        const V = State.variables;
        const minLimit = HM.config.shownMinLimit;
        const maxLimit = HM.config.shownMaxLimit;
        let minShown = HM.clampInteger(V.honestMarketsMinShown, minLimit, maxLimit, HM.config.minShown);
        let maxShown = HM.clampInteger(V.honestMarketsMaxShown, minLimit, maxLimit, HM.config.maxShown);

        // 被外部手段寫成「下限 > 上限」時交換兩值，核心生成端永遠只接收合法區間。
        if (minShown > maxShown) [minShown, maxShown] = [maxShown, minShown];

        return {
            minShown,
            maxShown,
            maxLot: HM.clampInteger(
                V.honestMarketsMaxLot,
                HM.config.maxLotMin,
                HM.config.maxLotMax,
                HM.config.maxLot
            )
        };
    };

    HM.setMarketSetting = function (key, value) {
        const V = State.variables;
        const current = HM.getMarketSettings();

        if (key === "minShown") {
            const next = HM.clampInteger(value, HM.config.shownMinLimit, HM.config.shownMaxLimit, HM.config.minShown);
            V.honestMarketsMinShown = Math.min(next, current.maxShown);
        } else if (key === "maxShown") {
            const next = HM.clampInteger(value, HM.config.shownMinLimit, HM.config.shownMaxLimit, HM.config.maxShown);
            V.honestMarketsMaxShown = Math.max(next, current.minShown);
        } else if (key === "maxLot") {
            V.honestMarketsMaxLot = HM.clampInteger(value, HM.config.maxLotMin, HM.config.maxLotMax, HM.config.maxLot);
        }
        return HM.getMarketSettings();
    };

    HM.resetMarketSettings = function () {
        const V = State.variables;
        V.honestMarketsMinShown = HM.config.minShown;
        V.honestMarketsMaxShown = HM.config.maxShown;
        V.honestMarketsMaxLot = HM.config.maxLot;
        return HM.getMarketSettings();
    };

    // maxLot 滑塊採兩段式映射：前半 50～500、後半 500～2500，讓預設 240 附近仍有足夠操作精度。
    HM.maxLotToSlider = function (value) {
        const v = HM.clampInteger(value, HM.config.maxLotMin, HM.config.maxLotMax, HM.config.maxLot);
        if (v <= 500) return Math.round((v - 50) / 450 * 500);
        return Math.round(500 + (v - 500) / 2000 * 500);
    };

    HM.sliderToMaxLot = function (position) {
        const p = HM.clampInteger(position, 0, 1000, HM.maxLotToSlider(HM.config.maxLot));
        const value = p <= 500
            ? 50 + (p / 500) * 450
            : 500 + ((p - 500) / 500) * 2000;
        return HM.clampInteger(value, HM.config.maxLotMin, HM.config.maxLotMax, HM.config.maxLot);
    };

    /*
     * ==================== 全局 Foodstuff 商品價值倍率 ====================
     *
     * 這項設定刻意不寫入 State.variables：它屬於 Mod 的全局經濟設定，
     * 應跨角色、跨存檔共用，因此使用 localStorage 保存。
     *
     * setup.foodstuff 是目前 runtime 的全局商品資料。修改 shop.sell_price 後，
     * 所有直接讀取該欄位的遊戲系統與其他 Mod 都會看到相同的新價格。
     *
     * 為避免 10× 改成 20× 時變成「已乘 10 再乘 20」，首次遇到商品時會先保存
     * 原始 sell_price；之後每次套用都固定使用「原價 × 目前倍率」重新計算。
     */
    /*
     * 全局商品價格倍率的資料分工：
     * - localStorage 只保存玩家選擇的非預設倍率，讓設定跨所有存檔共用。
     * - 1× 代表未自訂，因此會刪除儲存鍵，不留下沒有意義的預設資料。
     * - baseFoodstuffPrices 只保存目前 runtime 的原始價格快照，不進入存檔或 localStorage。
     *
     * 原價快照是倍率計算的不變基準。任何倍率切換都必須從原價重算，
     * 不能直接對目前價格再次相乘，否則連續切換倍率會造成價格累乘。
     */
    HM.PRICE_MULTIPLIER_STORAGE_KEY = "HonestMarkets.priceMultiplier";
    HM.baseFoodstuffPrices = HM.baseFoodstuffPrices instanceof Map ? HM.baseFoodstuffPrices : new Map();

    HM.normalizePriceMultiplier = function (value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return HM.config.priceMultiplier;
        return Math.max(HM.config.priceMultiplierMin, Math.min(HM.config.priceMultiplierMax, Math.round(n)));
    };

    HM.getPriceMultiplier = function () {
        try {
            const stored = localStorage.getItem(HM.PRICE_MULTIPLIER_STORAGE_KEY);
            return HM.normalizePriceMultiplier(stored === null ? HM.config.priceMultiplier : stored);
        } catch (_) {
            return HM.normalizePriceMultiplier(HM._priceMultiplierFallback ?? HM.config.priceMultiplier);
        }
    };

    HM.savePriceMultiplier = function (value) {
        const multiplier = HM.normalizePriceMultiplier(value);
        HM._priceMultiplierFallback = multiplier;

        try {
            /*
             * 1× 代表完全使用原版商品價格，不需要在 localStorage 留下一筆「預設值」。
             * 玩家從其他倍率調回 1× 時直接刪除設定；下次啟動若找不到 key，
             * getPriceMultiplier() 會自然回到 HM.config.priceMultiplier。
             */
            if (multiplier === HM.config.priceMultiplier) {
                localStorage.removeItem(HM.PRICE_MULTIPLIER_STORAGE_KEY);
            } else {
                localStorage.setItem(HM.PRICE_MULTIPLIER_STORAGE_KEY, String(multiplier));
            }
        } catch (_) {
            // localStorage 不可用時，本次 runtime 仍可正常使用。
        }

        return multiplier;
    };

    /*
     * 只補抓尚未建立快照的商品，既有快照永不覆寫。
     * 如此較晚初始化的相容 Mod 商品仍能被納入，又不會把已套用倍率的價格誤當成原價。
     */
    HM.captureBaseFoodstuffPrices = function () {
        if (!setup.foodstuff) return 0;
        let captured = 0;
        for (const [id, item] of Object.entries(setup.foodstuff)) {
            if (!item?.shop || HM.baseFoodstuffPrices.has(id)) continue;
            const price = Number(item.shop.sell_price);
            if (!Number.isFinite(price)) continue;
            HM.baseFoodstuffPrices.set(id, price);
            captured++;
        }
        return captured;
    };

    /*
     * 套用順序：
     * 1. 正規化並保存倍率。
     * 2. 在改價前補齊新商品的原價快照。
     * 3. 全部依「原價 × 倍率」重新計算。
     * 4. 清除依商品價格建立的偷摸分布快取，避免沿用舊價格尺度。
     */
    HM.applyFoodstuffPriceMultiplier = function (value = HM.getPriceMultiplier()) {
        const multiplier = HM.savePriceMultiplier(value);
        HM.captureBaseFoodstuffPrices();

        for (const [id, item] of Object.entries(setup.foodstuff ?? {})) {
            if (!item?.shop) continue;
            const basePrice = HM.baseFoodstuffPrices.get(id);
            if (!Number.isFinite(basePrice)) continue;
            item.shop.sell_price = Math.round(basePrice * multiplier);
        }

        // 偷竊價格分位快取依 sell_price 建立；倍率改變後必須讓下一次使用時重建。
        HM.theftPriceDistribution = null;
        HM._foodstuffPriceMultiplierApplied = multiplier;
        return multiplier;
    };

    const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const shuffle = array => {
        const a = array.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = rand(0, i);
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    };

    HM.moneyText = cents => `£${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;


    HM.marketMinutes = function () {
        if (typeof Time === "undefined") return null;
        const hour = Number(Time.hour);
        const minute = Number(Time.minute) || 0;
        if (!Number.isFinite(hour)) return null;
        return hour * 60 + minute;
    };

    // 官方市集正常營業時間為 07:00～20:59；其餘時段只保留場景敘述。
    HM.getMarketTimeState = function () {
        const minutes = HM.marketMinutes();
        if (minutes === null) return "open";
        if (minutes >= 360 && minutes < 420) return "preparing";
        if (minutes >= 420 && minutes < 1260) return "open";
        if (minutes >= 1260 && minutes < 1320) return "closing";
        return "closed";
    };

    HM.isMarketOpen = () => HM.getMarketTimeState() === "open";

    HM.marketDay = function () {
        if (typeof Time !== "undefined" && Number.isFinite(Number(Time.days))) return Number(Time.days);
        return null;
    };

    HM.isBannedToday = function () {
        const day = HM.marketDay();
        return day !== null && Number(State.variables.honestMarketsBannedDay) === day;
    };

    HM.canUseMarket = () => HM.isMarketOpen() && !HM.isBannedToday();

    HM.marketBanText = function () {
        return "你才剛靠近攤位，幾名攤販便認出了你。看來今天沒有人願意再和你做生意了。";
    };

    HM.advanceMinutes = function (minutes) {
        const amount = Math.max(0, Math.floor(Number(minutes) || 0));
        if (amount > 0) Wikifier.wikifyEval(`<<pass ${amount}>>`);
    };

    HM.marketClosedText = function () {
        switch (HM.getMarketTimeState()) {
            case "preparing":
                return "天色漸亮，攤販們正陸續準備今天的生意，市場還沒有正式開放。";
            case "closing":
                return "攤販們已經開始收拾剩餘的商品，今天的市場營業結束了。";
            case "closed":
                return "市場已經打烊，白天熱鬧的攤位如今只剩下一片寂靜。";
            default:
                return "";
        }
    };

    HM.canExploreMore = function () {
        const minutes = HM.marketMinutes();
        if (!HM.canUseMarket()) return false;
        if (minutes === null) return true;
        return minutes + 30 < 1260;
    };

    HM.isMarketFood = item => !!(
        item && item.shop && Number.isFinite(Number(item.shop.sell_price)) &&
        Number(item.shop.sell_price) > 0
    );

    HM.getCatalog = function () {
        if (!setup.foodstuff) return [];
        return Object.entries(setup.foodstuff)
            .filter(([, item]) => HM.isMarketFood(item))
            .map(([id, item]) => ({ id, item }));
    };

    HM.categoryKey = item => item.category || "other";
    HM.categoryName = function (item, key) {
        return item.category_cn || item.category_name || key || "其他";
    };

    HM.getCategories = function () {
        const map = new Map();
        HM.getCatalog().forEach(({ id, item }) => {
            const key = HM.categoryKey(item);
            if (!map.has(key)) map.set(key, { key, name: HM.categoryName(item, key), ids: [] });
            map.get(key).ids.push(id);
        });
        return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant-TW"));
    };

    /*
     * ==================== 一般商品批次與報價 ====================
     *
     * DoL 的 shop.sell_price 使用「便士」作為內部單位：100 = £1。
     * 這個值是玩家正常擺攤出售商品時的基準價，不是商店成本。
     * HonestMarkets 因此直接以 sell_price 作為進貨行情基準，再依批次大小乘上不同倍率。
     *
     * 批次越大，倍率區間越低：
     *   零散     1.20～1.60 × sell_price
     *   小批     0.95～1.20 × sell_price
     *   中批     0.75～1.00 × sell_price
     *   大批     0.55～0.80 × sell_price
     *   清倉     0.35～0.60 × sell_price
     *
     * 這裡只定義「價格倍率」；實際數量範圍由 getLotTypes() 依 maxLot 動態建立。
     */
    HM.lotTypes = [
        { key: "loose",     name: "零散", markupMin: 1.20, markupMax: 1.60 },
        { key: "small",     name: "小批", markupMin: 0.95, markupMax: 1.20 },
        { key: "medium",    name: "中批", markupMin: 0.75, markupMax: 1.00 },
        { key: "large",     name: "大批", markupMin: 0.55, markupMax: 0.80 },
        { key: "clearance", name: "清倉", markupMin: 0.35, markupMax: 0.60 }
    ];

    /*
     * 由 maxLot 建立五種批次的數量範圍。
     *
     * 零散與小批固定為 1～4、5～9，避免 maxLot 改動後連小額供貨的語意也一起漂移。
     * 剩餘區間以 maxLot 的 30% / 65% 作為中批與大批分界：
     *   medium = 10 ～ floor(maxLot × 0.30)
     *   large  = mediumMax + 1 ～ floor(maxLot × 0.65)
     *   clearance = largeMax + 1 ～ maxLot
     *
     * 例如 maxLot = 240：1～4 / 5～9 / 10～72 / 73～156 / 157～240。
     * 若 maxLot 太小而使某區間無法成立，最後的 filter 會直接略過該批次。
     */
    HM.getLotTypes = function (maxLot = HM.getMarketSettings().maxLot) {
        // 即使呼叫端直接傳入異常值，批次生成仍強制限制在玩家設定允許的安全範圍。
        const max = HM.clampInteger(maxLot, HM.config.maxLotMin, HM.config.maxLotMax, HM.config.maxLot);
        const mediumMax = Math.max(10, Math.floor(max * 0.30));
        const largeMax = Math.max(mediumMax + 1, Math.floor(max * 0.65));
        const ranges = [
            [1, 4],
            [5, 9],
            [10, mediumMax],
            [mediumMax + 1, largeMax],
            [largeMax + 1, max]
        ];

        return HM.lotTypes.map((type, index) => ({
            ...type,
            min: ranges[index][0],
            max: Math.min(ranges[index][1], max),
            weightIndex: index
        })).filter(type => type.min <= type.max);
    };

    /*
     * 商品單價只影響「抽到哪種批次」的權重，不直接決定數量。
     * 陣列順序固定對應：零散 / 小批 / 中批 / 大批 / 清倉。
     *
     * sell 同樣是便士：100 = £1、500 = £5、1500 = £15。
     * 價格越高，權重越偏向小批；價格越低，才較常生成大批或清倉，
     * 避免高價商品一次生成數百個，同時保留低價商品大量進貨轉售的玩法。
     */
    HM.lotWeights = function (sell) {
        if (sell <= 100)  return [15, 25, 30, 20, 10];
        if (sell <= 500)  return [20, 30, 30, 15, 5];
        if (sell <= 1500) return [30, 35, 25, 9, 1];
        return [50, 35, 13, 2, 0];
    };

    HM.pickWeightedIndex = function (weights) {
        const total = weights.reduce((sum, value) => sum + Math.max(0, value), 0);
        if (total <= 0) return 0;
        let roll = Math.random() * total;
        for (let i = 0; i < weights.length; i++) {
            roll -= Math.max(0, weights[i]);
            if (roll < 0) return i;
        }
        return weights.length - 1;
    };

    HM.randomFloat = function (min, max) {
        return min + Math.random() * (max - min);
    };

    HM.makeOffer = function (id, maxLot = HM.getMarketSettings().maxLot) {
        const item = setup.foodstuff[id];
        const sell = Math.max(1, Math.round(Number(item.shop.sell_price) || 1));
        const nativeBulk = Math.max(1, Math.floor(Number(item.shop.bought_in_bulk) || 1));

        const weights = HM.lotWeights(sell);
        const lotTypes = HM.getLotTypes(maxLot);
        const lotType = lotTypes[HM.pickWeightedIndex(lotTypes.map(type => weights[type.weightIndex]))];

        // 數量先受批次 min/max 限制，再盡量對齊原生 bought_in_bulk。
        // 例如批次 10～72、bought_in_bulk = 6，實際候選會是 12、18……72。
        // 若整個區間找不到任何合法倍數，才退回 step = 1，確保一定能生成有效數量。
        let minQty = lotType.min;
        let maxQty = lotType.max;
        let step = nativeBulk;

        let first = Math.ceil(minQty / step) * step;
        let last = Math.floor(maxQty / step) * step;
        if (first > last) {
            step = 1;
            first = minQty;
            last = maxQty;
        }
        const qty = first + rand(0, Math.floor((last - first) / step)) * step;

        /*
         * 報價公式：
         *   finalMultiplier = clamp(批次倍率 + 行情修正, 0.01, 2.00)
         *   wholesaleTotal  = round(sell_price × finalMultiplier × qty)
         *   wholesaleUnit   = wholesaleTotal / qty
         *
         * 行情修正為 -0.05～+0.05，代表同類批次仍有小幅市場波動。
         * wholesaleUnit 在生成時鎖定；之後即使只買掉部分庫存，也不重新抽倍率，
         * 剩餘商品只以「鎖定單價 × 剩餘數量」重算整批總價。
         */
        const baseMultiplier = HM.randomFloat(lotType.markupMin, lotType.markupMax);
        const marketModifier = HM.randomFloat(-0.05, 0.05);
        const finalMultiplier = Math.min(2.00, Math.max(0.01, baseMultiplier + marketModifier));
        const wholesaleTotal = Math.max(1, Math.round(sell * finalMultiplier * qty));
        const wholesaleUnit = wholesaleTotal / qty;

        return {
            id,
            qty,
            originalQty: qty,
            wholesaleTotal,
            originalWholesaleTotal: wholesaleTotal,
            wholesaleUnit,
            debug: {
                sellPrice: sell,
                lotType: lotType.key,
                lotTypeName: lotType.name,
                lotMin: lotType.min,
                lotMax: lotType.max,
                originalQty: qty,
                nativeBulk,
                baseMultiplier,
                marketModifier,
                finalMultiplier,
                weights: weights.slice()
            }
        };
    };

    // 任意購買數量都沿用該批次已鎖定的 wholesaleUnit。
    // 買完整批時直接使用 wholesaleTotal，避免浮點單價回乘後產生 1 便士的取整差。
    HM.batchPrice = function (offer, amount) {
        if (!offer || amount < 1) return 0;
        if (amount === offer.qty) return offer.wholesaleTotal;
        return Math.max(1, Math.round(offer.wholesaleUnit * amount));
    };

    /*
     * 可負擔判定優先嘗試整批；不足時由「目前庫存 - 1」往下找最大可買數量。
     * 部分購買仍使用同一 wholesaleUnit，因此不會因玩家錢少而切換到另一套價格。
     * 回傳 mode 只供 UI 決定顯示文字，實際扣款仍由 buy() 重新計算與驗證。
     */
    HM.affordability = function (offer) {
        const money = Math.max(0, Number(State.variables.money) || 0);
        if (!offer || offer.qty <= 0) return { mode: "soldout", amount: 0, price: 0 };

        if (money >= offer.wholesaleTotal) {
            return { mode: offer.qty === 1 ? "single" : "wholesale", amount: offer.qty, price: offer.wholesaleTotal };
        }

        for (let amount = offer.qty - 1; amount >= 1; amount--) {
            const price = HM.batchPrice(offer, amount);
            if (money >= price) return { mode: "partial", amount, price };
        }
        return { mode: "unaffordable", amount: 0, price: 0 };
    };
    HM.beginVisit = function () {
        const V = State.variables;
        HM.initTheftPriceDistribution();
        const categories = HM.getCategories();
        const settings = HM.getMarketSettings();
        const visit = { categories: {}, createdAt: Date.now(), settings: { ...settings } };

        categories.forEach(cat => {
            const count = Math.min(cat.ids.length, rand(settings.minShown, settings.maxShown));
            visit.categories[cat.key] = shuffle(cat.ids).slice(0, count).map(id => HM.makeOffer(id, settings.maxLot));
        });
        V.honestMarketsVisit = visit;
        V.honestMarketsCategory = null;
        return visit;
    };

    HM.ensureVisit = function () {
        const V = State.variables;
        if (!V.honestMarketsVisit || !V.honestMarketsVisit.categories) HM.beginVisit();
        return V.honestMarketsVisit;
    };

    HM.endVisit = function () {
        const V = State.variables;
        delete V.honestMarketsVisit;
        V.honestMarketsCategory = null;
    };

    HM.categoryRemaining = function (key) {
        return HM.getOffers(key).filter(offer => offer && offer.qty > 0).length;
    };

    HM.setCategory = function (key) {
        HM.ensureVisit();
        State.variables.honestMarketsCategory = key;
    };

    HM.getOffers = function (key) {
        const visit = HM.ensureVisit();
        return visit.categories[key] || [];
    };

    HM.buy = function (offer, amount, mode) {
        const V = State.variables;
        if (!HM.canUseMarket()) return false;
        if (!offer || !setup.foodstuff?.[offer.id]) return false;

        amount = Math.floor(Number(amount) || 0);
        if (amount < 1 || amount > offer.qty) return false;

        const price = HM.batchPrice(offer, amount);
        if ((Number(V.money) || 0) < price) return false;

        Wikifier.wikifyEval(`<<tending_give ${JSON.stringify(offer.id)} ${amount}>><<money -${price}>>`);

        offer.qty -= amount;
        if (offer.qty > 0) {
            offer.wholesaleTotal = Math.max(1, Math.round(offer.wholesaleUnit * offer.qty));
        }
        HM.advanceMinutes(5);
        return true;
    };
    HM.renderCategories = function () {
        const cats = HM.getCategories().filter(cat => HM.getOffers(cat.key).length);
        if (!cats.length) return '<span class="red">這裡暫時沒有可出售的食品。</span>';

        return cats.map(cat => {
            const remaining = HM.categoryRemaining(cat.key);
            if (remaining <= 0) {
                const tip = '這個分類的商品已經賣光了，也許應該再次探索市集。';
                return `<span class="grey">${cat.name}（售罄）</span> ` +
                    `<mouse class="tooltip-small linkBlue">(?)<span class="black">${tip}</span></mouse><br>`;
            }

            const label = `${cat.name}（${remaining}種）`;
            return `<<link ${JSON.stringify(label)} "HonestMarkets Category">>` +
                `<<run setup.HonestMarkets.setCategory(${JSON.stringify(cat.key)})>><</link>><br>`;
        }).join("");
    };

    // 行情提示以「正常擺攤 sell_price ÷ 本批進貨單價 - 1」估算毛利率。
    // < 0 為虧損；0～15% 為尚可；>= 15% 才標示有利可圖。
    // 這只是快速提示，不把 +20% 抬價擺攤納入一般判斷。
    HM.renderMarketHint = function (offer) {
        if (!offer?.debug || !(offer.wholesaleUnit > 0)) return "";

        const margin = (offer.debug.sellPrice / offer.wholesaleUnit) - 1;
        if (margin < 0) return ' <span class="red">【不太划算】</span>';
        if (margin < 0.15) return ' <span class="blue">【尚可】</span>';
        return ' <span class="green">【有利可圖】</span>';
    };

    HM.renderDebugTip = function (offer) {
        if (!State.variables.debug || !offer?.debug) return "";
        const d = offer.debug;
        const signedPct = value => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
        const weights = Array.isArray(d.weights) ? d.weights.join("/") : "-";
        const body = [
            `<b>HonestMarkets Debug</b>`,
            `ID：${offer.id}`,
            `原始 sell_price：${HM.moneyText(d.sellPrice)}`,
            `批次：${d.lotTypeName}（${d.lotMin}-${d.lotMax}）`,
            `原始生成數量：${d.originalQty}`,
            `bought_in_bulk：${d.nativeBulk}`,
            `批次權重：${weights}`,
            `基礎倍率：${d.baseMultiplier.toFixed(3)}×`,
            `行情修正：${signedPct(d.marketModifier)}`,
            `最終倍率：${d.finalMultiplier.toFixed(3)}×`,
            `生成批發單價：${HM.moneyText(offer.wholesaleUnit)}`,
            `正常擺攤基準：${HM.moneyText(d.sellPrice)} / 個`,
            `抬價擺攤基準：${HM.moneyText(Math.round(d.sellPrice * 1.2))} / 個`,
            `正常擺攤毛利：${offer.wholesaleUnit > 0 ? signedPct((d.sellPrice / offer.wholesaleUnit) - 1) : "-"}`,
            `抬價擺攤毛利：${offer.wholesaleUnit > 0 ? signedPct(((d.sellPrice * 1.2) / offer.wholesaleUnit) - 1) : "-"}`,
            `目前剩餘：${offer.qty}`,
            `目前整批價：${HM.moneyText(offer.wholesaleTotal)}`
        ].join("<br>");
        return ` <mouse class="tooltip-small linkBlue">(?)<span class="black">${body}</span></mouse>`;
    };

    HM.getSkulduggery = function () {
        if (typeof currentSkillValue === "function") {
            const value = Number(currentSkillValue("skulduggery"));
            if (Number.isFinite(value)) return Math.max(0, value);
        }
        return Math.max(0, Number(State.variables.skulduggery) || 0);
    };

    /*
     * ==================== 偷摸：候選商品能力門檻 ====================
     *
     * 偷摸不是直接拿「玩家詭術 vs 商品價格」做成功判定，而是分成三層：
     *   1. 候選門檻：詭術決定目前能考慮哪些價位的商品。
     *   2. 成功難度：入選後再由單價、數量、時段計算 $skulduggerydifficulty，
     *      最終成功／失敗交給 DoL 原生 <<skulduggerycheck>>。
     *   3. 被抓風險：只有原生檢定失敗後才判定，與成功率是兩個不同事件。
     *
     * 價格門檻採「當前 setup.foodstuff 價格分布的分位數」，而不是固定 £ 金額。
     * 因此官方或其他 Mod 改變商品價格後，下一次建立市場探索就會自動重新校準。
     * 只收集有效 shop.sell_price 並由低到高排序；使用分位數也可避免少數極端高價品
     * （例如遠高於一般食材的特殊物品）直接把整條能力曲線拉高。
     */
    HM.initTheftPriceDistribution = function () {
        HM.theftPriceDistribution = HM.getCatalog()
            .map(({ item }) => Number(item?.shop?.sell_price))
            .filter(price => Number.isFinite(price) && price > 0)
            .sort((a, b) => a - b);
        return HM.theftPriceDistribution;
    };

    /*
     * 詭術 → 可偷價格分位：
     *   0    → P10
     *   200  → P25
     *   400  → P50
     *   600  → P75
     *   800  → P90
     *   1000 → P95
     *
     * 節點之間線性插值，例如詭術 500 位於 400～600 正中間，得到 P62.5。
     * 1000 以上固定 P95，不開放最昂貴約 5% 商品，避免滿級後完全失去價值門檻。
     * 注意：這裡只決定「能否成為候選」，不代表該商品一定容易偷成功。
     */
    HM.theftPercentileForSkill = function (skulduggery = HM.getSkulduggery()) {
        const skill = Math.max(0, Number(skulduggery) || 0);
        const points = [
            [0, 0.10],
            [200, 0.25],
            [400, 0.50],
            [600, 0.75],
            [800, 0.90],
            [1000, 0.95]
        ];
        if (skill >= points[points.length - 1][0]) return points[points.length - 1][1];
        for (let i = 1; i < points.length; i++) {
            const [s1, p1] = points[i];
            if (skill <= s1) {
                const [s0, p0] = points[i - 1];
                const t = (skill - s0) / (s1 - s0);
                return p0 + (p1 - p0) * t;
            }
        }
        return points[0][1];
    };

    // 將 0～1 分位轉回實際 sell_price。position = (N - 1) × percentile。
    // 若 position 落在兩筆價格之間，依小數部分線性插值；這讓能力門檻隨詭術平滑變化，
    // 而不是只有跨過某個商品價格時才突然跳升。回傳值仍是 DoL 內部貨幣單位（便士）。
    HM.theftPriceQuantile = function (percentile) {
        const prices = HM.theftPriceDistribution?.length
            ? HM.theftPriceDistribution
            : HM.initTheftPriceDistribution();
        if (!prices.length) return 1;
        const p = Math.min(1, Math.max(0, Number(percentile) || 0));
        const position = (prices.length - 1) * p;
        const lower = Math.floor(position);
        const upper = Math.ceil(position);
        if (lower === upper) return prices[lower];
        const t = position - lower;
        return prices[lower] + (prices[upper] - prices[lower]) * t;
    };

    HM.maxStealableUnitValue = function (skulduggery = HM.getSkulduggery()) {
        return Math.max(1, HM.theftPriceQuantile(HM.theftPercentileForSkill(skulduggery)));
    };

    HM.canStealItem = function (item, skulduggery = HM.getSkulduggery()) {
        const sell = Math.max(1, Number(item?.shop?.sell_price) || 1);
        return sell <= HM.maxStealableUnitValue(skulduggery);
    };

    /*
     * 通過價格門檻後，再用「能力上限 ÷ 商品單價」決定一次最多能摸幾個。
     * maxQty = 1 + floor(log2(limit / sell))，最後限制為 1～12。
     *
     * 因此商品越接近能力上限，通常只能拿 1 個；每便宜一半才增加約 1 個容量：
     *   limit / sell = 1× → 1 個
     *                  2× → 2 個
     *                  4× → 3 個
     *                  8× → 4 個
     *                 16× → 5 個
     *                 32× → 6 個
     *                 64× → 7 個，之後每翻倍再 +1，最高 12 個。
     * 這同時抑制「高價又大量」的極端偷摸目標。
     */
    HM.getStealMaxQty = function (item, skulduggery = HM.getSkulduggery()) {
        const sell = Math.max(1, Number(item?.shop?.sell_price) || 1);
        const limit = HM.maxStealableUnitValue(skulduggery);
        if (sell > limit) return 0;
        const ratio = Math.max(1, limit / sell);
        return Math.min(12, 1 + Math.floor(Math.log2(ratio)));
    };

    /*
     * 時段只修改成功檢定 difficulty，不會提高可偷價格上限。
     * 07:00～18:59：0
     * 19:00～19:59：基準 -50
     * 20:00～20:59：基準 -150
     *
     * 非零基準再乘 0.75～1.25，因此 -50 實際約 -38～-63，-150 約 -113～-188。
     * 負值代表越接近收攤越容易下手；波動在「觀察目標」時產生並存進 theft，
     * 後續確認頁不會重新抽取本次 difficulty。
     */
    HM.theftTimeModifier = function () {
        const minutes = HM.marketMinutes();
        if (minutes === null) return 0;

        let base = 0;
        if (minutes >= 1140 && minutes < 1200) base = -50;       // 19:00～19:59
        else if (minutes >= 1200 && minutes < 1260) base = -150; // 20:00～20:59

        if (base === 0) return 0;
        const factor = HM.randomFloat(0.75, 1.25);
        return Math.round(base * factor);
    };

    /*
     * 將商品價格換成目前價格分布中的相對分位。
     *
     * 這裡不用固定 £ 金額當基準。若整個經濟一起變成 10×，所有商品與分位價格會
     * 同比例上升，同一商品仍位於相同的相對位置，因此偷摸難度不會被貨幣尺度扭曲。
     *
     * 相同價格可能同時出現很多次，所以使用該價格在排序陣列中的「中間排名」
     * （第一個位置與最後一個位置的平均）計算 percentile，避免同價商品因排序位置
     * 不同得到不同難度。
     */
    HM.theftPricePercentile = function (item) {
        const sell = Math.max(1, Number(item?.shop?.sell_price) || 1);
        const prices = HM.theftPriceDistribution?.length
            ? HM.theftPriceDistribution
            : HM.initTheftPriceDistribution();
        if (prices.length <= 1) return 0;

        let low = 0;
        let high = prices.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (prices[mid] < sell) low = mid + 1;
            else high = mid;
        }
        const first = low;

        low = 0;
        high = prices.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (prices[mid] <= sell) low = mid + 1;
            else high = mid;
        }
        const last = low - 1;

        const position = last >= first ? (first + last) / 2 : first;
        return Math.min(1, Math.max(0, position / (prices.length - 1)));
    };

    /*
     * 將「價格分位」換算成 valueDifficulty。
     *
     * 這條曲線刻意與 theftPercentileForSkill() 的能力門檻互為對應：
     *   P10 →   0
     *   P25 → 200
     *   P50 → 400
     *   P75 → 600
     *   P90 → 800
     *   P95 → 1000
     *
     * 節點之間線性插值。P10 以下維持 0；P95 以上維持 1000。
     * 正常候選池最高本來就只開放到 P95，因此上限主要也是異常資料防護。
     *
     * 這代表「價格難度」描述的是商品在目前遊戲經濟中的相對昂貴程度，
     * 而不是某個固定英鎊數字。官方、其他 Mod 或全局倍率改變整體價格尺度時，
     * 系統會隨目前商品分布自動校準。
     */
    HM.theftValueDifficulty = function (item) {
        const percentile = HM.theftPricePercentile(item);
        const points = [
            [0.10, 0],
            [0.25, 200],
            [0.50, 400],
            [0.75, 600],
            [0.90, 800],
            [0.95, 1000]
        ];

        if (percentile <= points[0][0]) return points[0][1];
        if (percentile >= points[points.length - 1][0]) return points[points.length - 1][1];

        for (let i = 1; i < points.length; i++) {
            const [p1, d1] = points[i];
            if (percentile <= p1) {
                const [p0, d0] = points[i - 1];
                const t = (percentile - p0) / (p1 - p0);
                return d0 + (d1 - d0) * t;
            }
        }
        return 0;
    };

    /*
     * ==================== 偷摸：原版成功／失敗難度 ====================
     *
     * difficulty = 300 + valueDifficulty + quantityDifficulty + timeModifier
     *
     * valueDifficulty 由商品目前所在的價格分位決定。
     * P10/P25/P50/P75/P90/P95 約對應 +0/+200/+400/+600/+800/+1000。
     *
     * quantityDifficulty = max(0, amount - 1) × 75
     *   - 第 1 個不加難度；從第 2 個起每多拿 1 個 +75。
     *
     * timeModifier 由 theftTimeModifier() 提供，19/20 點為負值。
     * 最終結果四捨五入且最低為 0。這個數值會寫入 $skulduggerydifficulty，
     * 真正成功／失敗仍由 DoL 原生 <<skulduggerycheck "silent">> 判定，HM 不另造成功率公式。
     *
     * 由於候選門檻與價格難度現在共用同一份動態價格分布，全局商品價格倍率只改變
     * 經濟金額，不會改變商品的相對價格分位，因此也不會額外放大偷摸難度。
     */
    HM.theftDifficulty = function (item, amount = 1, timeModifier = HM.theftTimeModifier()) {
        const valueDifficulty = HM.theftValueDifficulty(item);
        const quantityDifficulty = Math.max(0, Math.floor(amount) - 1) * 75;
        return Math.max(0, Math.round(valueDifficulty + 300 + quantityDifficulty + timeModifier));
    };

    HM.prepareTheft = function (categoryKey) {
        const V = State.variables;
        if (!HM.canUseMarket()) {
            delete V.honestMarketsTheft;
            return false;
        }
        const skulduggery = HM.getSkulduggery();
        const candidates = HM.getOffers(categoryKey).filter(offer => {
            if (!(offer.qty > 0)) return false;
            const item = setup.foodstuff?.[offer.id];
            return item && HM.canStealItem(item, skulduggery);
        });
        if (!candidates.length) {
            delete V.honestMarketsTheft;
            return false;
        }

        const offer = candidates[rand(0, candidates.length - 1)];
        const item = setup.foodstuff[offer.id];
        const theoreticalMaxAmount = HM.getStealMaxQty(item, skulduggery);
        const maxAmount = Math.min(offer.qty, theoreticalMaxAmount);
        const amount = rand(1, Math.max(1, maxAmount));
        const name = amount > 1
            ? (item.plural || item.singular || item.name || offer.id)
            : (item.singular || item.name || offer.id);

        const timeModifier = HM.theftTimeModifier();
        V.honestMarketsTheft = {
            categoryKey,
            id: offer.id,
            amount,
            /* Debug／狀態資訊：分開保留能力公式上限與庫存限制後上限，方便判斷本次隨機數量為何。 */
            stockQty: offer.qty,
            theoreticalMaxAmount,
            maxAmount,
            name,
            unitValue: Math.max(1, Number(item.shop.sell_price) || 1),
            /*
             * 新版 DoL crimeUp() 的第一參數使用 £，而 foodstuff sell_price 使用便士。
             * 因此在找到目標時就把「單價 × 數量」換算成 £ 並鎖定。
             * 這個值只描述本次企圖竊取的實際財物價值，與百分位化的偷摸難度分開：
             * 全局價格倍率可以不改變相對難度，但仍應改變實際犯罪價值。
             */
            crimeValue: (Math.max(1, Number(item.shop.sell_price) || 1) * amount) / 100,
            itemPricePercentile: HM.theftPricePercentile(item),
            valueDifficulty: HM.theftValueDifficulty(item),
            pricePercentile: HM.theftPercentileForSkill(skulduggery),
            maxUnitValue: HM.maxStealableUnitValue(skulduggery),
            difficulty: HM.theftDifficulty(item, amount, timeModifier),
            timeModifierBase: timeModifier === 0 ? 0 : (HM.marketMinutes() >= 1200 ? -150 : -50),
            timeModifier
        };

        /*
         * ==================== 偷摸：失敗後被抓風險 ====================
         *
         * 這一層只在原版 skulduggerycheck 已經失敗後使用；成功時完全不骰被抓。
         * 因此「一次下手最後被抓」的總體風險約為：原版失敗率 × caughtChance。
         *
         * 先用能力負荷衡量玩家是否在勉強挑戰：
         *   load = difficulty / max(1, skulduggery)
         * max(1, ...) 只為避免詭術 0 時除以 0。
         *
         * 基礎被抓率：
         *   load <= 0.50 → 20%
         *   load >  0.50 → 20% + (load - 0.50) × 30%
         *   上限 65%
         * 例：load 0.50 = 20%、1.00 = 35%、1.50 = 50%、2.00 = 65%。
         *
         * 再乘 caughtVariance = 0.75～1.25，模擬攤販注意力、視線與周遭人流等現場差異。
         * 最終 caughtChance 限制為 10%～75%，避免任何目標變成近乎必抓或完全無風險。
         *
         * load、基礎率、波動倍率與最終率都在 prepareTheft() 找到目標時一次鎖定。
         * 這很重要：確認頁重繪或停留不能反覆洗 RNG；失敗時只拿已鎖定 caughtChance 做最後一次 0～1 骰值。
         */
        const theft = V.honestMarketsTheft;
        const load = theft.difficulty / Math.max(1, skulduggery);
        const baseCaughtChance = Math.min(0.65, Math.max(0.20, 0.20 + Math.max(0, load - 0.50) * 0.30));
        const caughtVariance = HM.randomFloat(0.75, 1.25);
        theft.caughtLoad = load;
        theft.baseCaughtChance = baseCaughtChance;
        theft.caughtVariance = caughtVariance;
        theft.caughtChance = Math.min(0.75, Math.max(0.10, baseCaughtChance * caughtVariance));
        return true;
    };

    // 讀取已鎖定的最終被抓率；10%～75% 的 clamp 同時作為舊存檔／異常資料防護。
    HM.theftCaughtChance = function (theft = State.variables.honestMarketsTheft) {
        return theft ? Math.min(0.75, Math.max(0.10, Number(theft.caughtChance) || 0.20)) : 0;
    };

    // 只有偷摸失敗後才呼叫：抽 0～1，低於 caughtChance 即視為被當場抓到。
    HM.rollTheftCaught = function (theft = State.variables.honestMarketsTheft) {
        return HM.randomFloat(0, 1) < HM.theftCaughtChance(theft);
    };

    HM.banMarketToday = function () {
        const day = HM.marketDay();
        if (day === null) return false;
        State.variables.honestMarketsBannedDay = day;
        HM.endVisit();
        return true;
    };

    HM.completeTheft = function () {
        const V = State.variables;
        const theft = V.honestMarketsTheft;
        if (!theft) return false;

        const offer = HM.getOffers(theft.categoryKey).find(entry => entry.id === theft.id && entry.qty > 0);
        if (!offer) return false;

        const amount = Math.min(Math.max(1, Math.floor(theft.amount || 1)), offer.qty);
        Wikifier.wikifyEval(`<<tending_give ${JSON.stringify(theft.id)} ${amount}>>`);
        offer.qty -= amount;
        if (offer.qty > 0) {
            offer.wholesaleTotal = Math.max(1, Math.round(offer.wholesaleUnit * offer.qty));
        }
        theft.amount = amount;
        return true;
    };

    HM.renderTheftAction = function (categoryKey) {
        if (!HM.canUseMarket()) return "";
        const skulduggery = HM.getSkulduggery();
        const candidates = HM.getOffers(categoryKey).filter(offer => {
            const item = setup.foodstuff?.[offer.id];
            return offer.qty > 0 && item && HM.canStealItem(item, skulduggery);
        });
        if (!candidates.length) {
            return `<<crimeicon "mark">><span class="grey">這裡暫時沒有你有把握下手的商品。</span><<crime "petty">><br>`;
        }
        return `<<crimeicon "mark">><<link "偷摸點東西 (00:05)" "HonestMarkets Steal">>` +
            `<<run setup.HonestMarkets.prepareTheft(${JSON.stringify(categoryKey)})>><<run setup.HonestMarkets.advanceMinutes(5)>><</link>>` +
            `<<crime "petty">><br>`;
    };

    HM.renderOffers = function () {
        if (HM.isBannedToday()) return `<span class="grey">${HM.marketBanText()}</span>`;
        if (!HM.isMarketOpen()) return `<span class="grey">${HM.marketClosedText()}</span>`;
        const key = State.variables.honestMarketsCategory;
        const category = HM.getCategories().find(cat => cat.key === key);
        if (!category) return '<span class="red">這個攤位已經找不到了。</span>';
        const offers = HM.getOffers(key);
        const available = offers.filter(offer => offer.qty > 0);
        if (!available.length) return '<span class="blue">這個分類的商品已經賣光了，也許應該再次探索市集。</span>';

        return offers.map((offer, i) => {
            if (offer.qty <= 0) return "";
            const item = setup.foodstuff[offer.id];
            const name = offer.qty > 1 ? (item.plural || item.singular || item.name || offer.id) : (item.singular || item.name || offer.id);
            const icon = `<<foodstufficon ${JSON.stringify(offer.id)}>>`;
            const state = HM.affordability(offer);
            const lotInfo = offer.qty > 1
                ? `${name} × ${offer.qty}個，整批 ${HM.moneyText(offer.wholesaleTotal)}`
                : `${name} × 1個，${HM.moneyText(offer.wholesaleTotal)}`;
            const marketHint = HM.renderMarketHint(offer);
            const debugTip = HM.renderDebugTip(offer);

            if (state.mode === "single") {
                const label = `購買 1 個（${HM.moneyText(state.price)}）(00:05)`;
                return `${icon}${lotInfo}${marketHint}${debugTip}<br>` +
                    `<<link ${JSON.stringify(label)} "HonestMarkets Category">>` +
                    `<<run setup.HonestMarkets.buy(setup.HonestMarkets.getOffers(${JSON.stringify(key)})[${i}], 1, "single")>><</link>><br><br>`;
            }

            if (state.mode === "wholesale") {
                const label = `整批購買 ${offer.qty} 個（${HM.moneyText(state.price)}）(00:05)`;
                return `${icon}${lotInfo}${marketHint}${debugTip}<br>` +
                    `<<link ${JSON.stringify(label)} "HonestMarkets Category">>` +
                    `<<run setup.HonestMarkets.buy(setup.HonestMarkets.getOffers(${JSON.stringify(key)})[${i}], ${state.amount}, "wholesale")>><</link>><br><br>`;
            }

            if (state.mode === "partial") {
                const label = `你只夠買 ${state.amount} 個（${HM.moneyText(state.price)}）(00:05)`;
                return `${icon}${lotInfo}${marketHint}${debugTip}<br>` +
                    `<<link ${JSON.stringify(label)} "HonestMarkets Category">>` +
                    `<<run setup.HonestMarkets.buy(setup.HonestMarkets.getOffers(${JSON.stringify(key)})[${i}], ${state.amount}, "partial")>><</link>><br><br>`;
            }

            return `${icon}${lotInfo}${marketHint}${debugTip}<br><span class="grey">（你的錢不夠）</span><br><br>`;
        }).join("");
    };


    // DoL 以 tending.has_seeds 判斷植物是否具有可購買種子。
    HM.isSeedPlant = function (item) {
        return !!(item?.tending?.has_seeds);
    };

    HM.getKnownPlants = function () {
        const known = State.variables.plants_known;
        if (Array.isArray(known)) return known;
        if (known && typeof known === "object") {
            return Object.keys(known).filter(key => known[key]);
        }
        return [];
    };

    HM.getSeedCatalog = function () {
        if (!setup.foodstuff) return [];
        const known = new Set(HM.getKnownPlants());
        return Object.entries(setup.foodstuff)
            .filter(([id, item]) => HM.isSeedPlant(item) && !known.has(id))
            .map(([id, item]) => ({ id, item }));
    };

    HM.seedPrice = function (item) {
        const sellPrice = Math.max(0, Number(item?.shop?.sell_price) || 0);
        /*
         * 種子價格同樣使用便士：
         *   raw = £1000 + sqrt(作物 sell_price / £1) × £250
         *       = 100000 + sqrt(sellPrice / 100) × 25000
         *
         * 平方根讓高價作物的種子會更貴，但不會與作物價格線性暴增。
         * 最後 ceil(raw / 1000) × 1000，亦即一律向上取整到 £10。
         */
        const raw = 100000 + Math.sqrt(sellPrice / 100) * 25000;
        return Math.ceil(raw / 1000) * 1000;
    };

    HM.seedDay = function () {
        if (typeof Time !== "undefined" && Number.isFinite(Number(Time.days))) {
            return Number(Time.days);
        }
        const V = State.variables;
        return Number(V.days) || Number(V.day) || 0;
    };

    // 每五個遊戲日為一個固定進貨週期。
    HM.seedCycle = function () {
        return Math.floor(HM.seedDay() / 5);
    };

    HM.generateDailySeeds = function () {
        const V = State.variables;
        const day = HM.seedDay();
        const cycle = HM.seedCycle();
        const catalog = HM.getSeedCatalog();
        const count = Math.min(catalog.length, rand(0, 3));
        const offers = shuffle(catalog).slice(0, count).map(({ id, item }) => ({
            id,
            price: HM.seedPrice(item)
        }));

        V.honestMarketsSeeds = {
            day,
            cycle,
            offers
        };
        return V.honestMarketsSeeds;
    };

    HM.ensureDailySeeds = function () {
        const V = State.variables;
        const cycle = HM.seedCycle();
        if (!V.honestMarketsSeeds ||
            V.honestMarketsSeeds.cycle !== cycle ||
            !Array.isArray(V.honestMarketsSeeds.offers)) {
            return HM.generateDailySeeds();
        }

        const known = new Set(HM.getKnownPlants());
        V.honestMarketsSeeds.offers = V.honestMarketsSeeds.offers.filter(
            offer => offer?.id && setup.foodstuff?.[offer.id] && !known.has(offer.id)
        );
        return V.honestMarketsSeeds;
    };

    HM.buySeed = function (id) {
        const V = State.variables;
        if (!HM.canUseMarket()) return false;
        const daily = HM.ensureDailySeeds();
        const index = daily.offers.findIndex(offer => offer.id === id);
        if (index < 0) return false;

        const item = setup.foodstuff?.[id];
        if (!HM.isSeedPlant(item)) {
            daily.offers.splice(index, 1);
            return false;
        }

        const known = HM.getKnownPlants();
        if (known.includes(id)) {
            daily.offers.splice(index, 1);
            return false;
        }

        const price = HM.seedPrice(item);
        if ((Number(V.money) || 0) < price) return false;

        V.money -= price;
        if (!Array.isArray(V.plants_known)) V.plants_known = [];
        if (!V.plants_known.includes(id)) V.plants_known.push(id);

        // 購買後立即移除，本週期不補貨。
        daily.offers.splice(index, 1);
        HM.advanceMinutes(5);
        return true;
    };

    HM.seedDisplayName = function (id) {
        const item = setup.foodstuff?.[id] || {};
        return item.tending?.seed_name ||
            item.singular ||
            item.plural ||
            item.name ||
            id;
    };

    HM.renderSeedDebugTip = function (id, price) {
        if (!State.variables.debug) return "";
        const item = setup.foodstuff?.[id] || {};
        const sellPrice = Math.max(0, Number(item?.shop?.sell_price) || 0);
        const raw = 100000 + Math.sqrt(sellPrice / 100) * 25000;
        const body = [
            `<b>HonestMarkets Seed Debug</b>`,
            `ID：${id}`,
            `Time.days：${HM.seedDay()}`,
            `五日週期：${HM.seedCycle()}`,
            `原始 sell_price：${HM.moneyText(sellPrice)}`,
            `固定基礎價：£1000`,
            `價值加成：${HM.moneyText(raw - 100000)}`,
            `取整前：${HM.moneyText(raw)}`,
            `最終種子價：${HM.moneyText(price)}`
        ].join("<br>");
        return ` <mouse class="tooltip-small linkBlue">(?)<span class="black">${body}</span></mouse>`;
    };

    HM.renderSeeds = function () {
        if (HM.isBannedToday()) return `<span class="grey">${HM.marketBanText()}</span>`;
        if (!HM.isMarketOpen()) return `<span class="grey">${HM.marketClosedText()}</span>`;
        const daily = HM.ensureDailySeeds();
        if (!daily.offers.length) {
            return '<span class="blue">這次進貨沒有看到你尚未解鎖的新種子，請等待下一次進貨。</span>';
        }

        return daily.offers.map(offer => {
            const id = offer.id;
            const item = setup.foodstuff?.[id];
            if (!item) return "";

            const price = HM.seedPrice(item);
            offer.price = price;

            const name = HM.seedDisplayName(id);
            const icon = `<<foodstufficon ${JSON.stringify(id)}>>`;
            const debugTip = HM.renderSeedDebugTip(id, price);

            if ((Number(State.variables.money) || 0) >= price) {
                const label = `購買${name}種子（${HM.moneyText(price)}）(00:05)`;
                return `${icon}${name}種子　${HM.moneyText(price)}${debugTip}<br>` +
                    `<<link ${JSON.stringify(label)} "HonestMarkets Seeds">>` +
                    `<<run setup.HonestMarkets.buySeed(${JSON.stringify(id)})>><</link>><br><br>`;
            }

            return `${icon}${name}種子　${HM.moneyText(price)}${debugTip}<br>` +
                `<span class="grey">（你的錢不夠）</span><br><br>`;
        }).join("");
    };

    HM.currentCategoryName = function () {
        const key = State.variables.honestMarketsCategory;
        return HM.getCategories().find(cat => cat.key === key)?.name || "商品";
    };

    HM.renderOptionsControl = function (output) {
        /*
         * Maplebirch 只負責把 <<HonestMarkets_options>> 掛進 Options。
         * 此處完全使用 DOM API 建立獨立區塊，避免與其他 Mod 的設定內容混成同一組，
         * 也避免把可變數值或文字拼進 HTML 字串。
         */
        // Maplebirch 會把這個節點插入 Options；標題與內容保持同層，避免把設定內容塞進 settingsHeader。
        const root = document.createElement("div");
        root.className = "honest-markets-options-root";

        const heading = document.createElement("div");
        heading.className = "settingsHeader options";
        heading.textContent = "誠信小販+";
        root.appendChild(heading);

        const content = document.createElement("div");
        content.className = "honest-markets-options";
        root.appendChild(content);

        const style = document.createElement("style");
        style.textContent = [
            ".honest-markets-options{padding:.2em .15em .35em}",
            ".honest-markets-options .hm-options-description{margin:.15em 0 .7em;line-height:1.55}",
            ".honest-markets-options .hm-option-row{padding:.85em .2em .95em;margin:0;border-top:1px solid rgba(128,128,128,.22)}",
            ".honest-markets-options .hm-option-heading{display:flex;align-items:center;gap:.5em;flex-wrap:wrap;margin-bottom:.22em}",
            ".honest-markets-options .hm-option-title{font-weight:700;line-height:1.35}",
            ".honest-markets-options .hm-option-scope{display:inline-block;padding:.08em .5em;border:1px solid currentColor;border-radius:999px;font-size:.78em;line-height:1.45;opacity:.72}",
            ".honest-markets-options .hm-option-description{margin:0 0 .55em;line-height:1.45;opacity:.88}",
            ".honest-markets-options .hm-option-controls{display:flex;align-items:center;gap:.35em;min-width:0}",
            ".honest-markets-options .hm-option-controls button{min-width:2.8em;padding:.25em .48em}",
            ".honest-markets-options .hm-option-controls input[type=range]{flex:1 1 240px;min-width:90px;margin:0 .1em}",
            ".honest-markets-options .hm-option-value{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:4.4em;padding:.18em .55em;border:1px solid rgba(128,128,128,.42);border-radius:999px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}",
            ".honest-markets-options .hm-option-note{margin-top:.42em;line-height:1.4;font-size:.92em}",
            ".honest-markets-options .hm-options-footer{display:flex;justify-content:flex-end;padding:.9em .2em .2em;border-top:1px solid rgba(128,128,128,.22)}",
            ".honest-markets-options .hm-reset{padding:.3em .8em}",
            "@media(max-width:520px){.honest-markets-options .hm-option-controls{flex-wrap:wrap}.honest-markets-options .hm-option-controls input[type=range]{order:2;flex:1 0 100%;margin:.25em 0}.honest-markets-options .hm-option-value{margin-left:auto}}"
        ].join("");
        root.appendChild(style);

        const description = document.createElement("p");
        description.className = "hm-options-description";
        description.textContent = "調整動態市場的商品供應規模，以及遊戲中的整體商品價格。市場供應設定從下一次建立的新市場生效；全局商品價格倍率則會立即套用。";
        content.appendChild(description);

        const makeButton = (label, delta) => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.dataset.delta = String(delta);
            return button;
        };

        const makeOption = ({ key, title, scopeLabel, descriptionText, min, max, step, deltas, note }) => {
            const row = document.createElement("div");
            row.className = "hm-option-row";
            row.dataset.key = key;

            const headingRow = document.createElement("div");
            headingRow.className = "hm-option-heading";

            const titleNode = document.createElement("div");
            titleNode.className = "hm-option-title";
            titleNode.textContent = title;
            headingRow.appendChild(titleNode);

            if (scopeLabel) {
                const scope = document.createElement("span");
                scope.className = "hm-option-scope";
                scope.textContent = scopeLabel;
                headingRow.appendChild(scope);
            }

            row.appendChild(headingRow);

            const desc = document.createElement("p");
            desc.className = "hm-option-description";
            desc.textContent = descriptionText;
            row.appendChild(desc);

            const controls = document.createElement("div");
            controls.className = "hm-option-controls";

            const negative = deltas.filter(delta => delta < 0);
            const positive = deltas.filter(delta => delta > 0);
            negative.forEach(delta => controls.appendChild(makeButton(String(delta), delta)));

            const input = document.createElement("input");
            input.type = "range";
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.setAttribute("aria-label", title);
            controls.appendChild(input);

            positive.forEach(delta => controls.appendChild(makeButton(`+${delta}`, delta)));

            const value = document.createElement("span");
            value.className = "hm-option-value";
            value.setAttribute("aria-live", "polite");
            controls.appendChild(value);
            row.appendChild(controls);

            if (note) {
                const noteNode = document.createElement("div");
                noteNode.className = "hm-option-note grey";
                noteNode.textContent = note;
                row.appendChild(noteNode);
            }

            content.appendChild(row);
            return row;
        };

        makeOption({
            key: "minShown",
            title: "每分類最少商品數量",
            descriptionText: "控制每個商品分類在新市場中隨機抽取的最低商品種類數。",
            min: HM.config.shownMinLimit,
            max: HM.config.shownMaxLimit,
            step: 1,
            deltas: [-1, 1],
            note: `範圍 ${HM.config.shownMinLimit}～${HM.config.shownMaxLimit}，預設 ${HM.config.minShown}；不會高於「每分類最多商品數量」。`
        });

        makeOption({
            key: "maxShown",
            title: "每分類最多商品數量",
            descriptionText: "控制每個商品分類在新市場中隨機抽取的最高商品種類數。",
            min: HM.config.shownMinLimit,
            max: HM.config.shownMaxLimit,
            step: 1,
            deltas: [-1, 1],
            note: `範圍 ${HM.config.shownMinLimit}～${HM.config.shownMaxLimit}，預設 ${HM.config.maxShown}；不會低於「每分類最少商品數量」。`
        });

        makeOption({
            key: "maxLot",
            title: "市場最大批次數量",
            descriptionText: "控制一般商品單批可能生成的最大數量。數值越高，大批與清倉可能出現更多庫存；實際數量仍會依商品價值與批次類型決定。",
            min: 0,
            max: 1000,
            step: 1,
            deltas: [-10, -1, 1, 10],
            note: `範圍 ${HM.config.maxLotMin}～${HM.config.maxLotMax}，預設 ${HM.config.maxLot}。滑塊採兩段式映射，並可用左右按鈕精細調整。`
        });

        makeOption({
            key: "priceMultiplier",
            title: "全局商品價值倍率",
            scopeLabel: "全局・所有存檔",
            descriptionText: "調整遊戲中商品的整體價格尺度，會同時影響商品的購買與出售價格，以及 HonestMarkets 等相關系統。此設定為全局設定，會套用至所有存檔。",
            min: HM.config.priceMultiplierMin,
            max: HM.config.priceMultiplierMax,
            step: 1,
            deltas: [-10, -1, 1, 10],
            note: `範圍 ${HM.config.priceMultiplierMin}×～${HM.config.priceMultiplierMax}×，預設 ${HM.config.priceMultiplier}×；建議 5～20×。注意：提高倍率後，超市等商店的商品價格也會同步提高。`
        });

        const footer = document.createElement("div");
        footer.className = "hm-options-footer";
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "hm-reset";
        reset.textContent = "恢復預設";
        footer.appendChild(reset);
        content.appendChild(footer);

        /*
         * 這個介面同時呈現兩種不同生命週期的設定：
         * 市場供應設定屬於存檔資料，下一次建立市場時才影響新供貨；
         * 全局商品價格倍率跨存檔共用，操作後立即套用。
         * refresh() 僅把目前有效值同步到控制項，不負責改寫設定。
         */
        const refresh = () => {
            const settings = HM.getMarketSettings();
            root.querySelectorAll(".hm-option-row").forEach(row => {
                const key = row.dataset.key;
                const input = row.querySelector('input[type="range"]');
                const value = key === "priceMultiplier" ? HM.getPriceMultiplier() : settings[key];
                input.value = key === "maxLot" ? HM.maxLotToSlider(value) : value;
                row.querySelector(".hm-option-value").textContent = key === "priceMultiplier" ? `${value}×` : String(value);

                row.querySelectorAll("button[data-delta]").forEach(button => {
                    const delta = Number(button.dataset.delta);
                    const limit = key === "maxLot"
                        ? (delta < 0 ? HM.config.maxLotMin : HM.config.maxLotMax)
                        : key === "priceMultiplier"
                            ? (delta < 0 ? HM.config.priceMultiplierMin : HM.config.priceMultiplierMax)
                            : (delta < 0 ? HM.config.shownMinLimit : HM.config.shownMaxLimit);
                    button.disabled = delta < 0 ? value <= limit : value >= limit;
                });
            });
        };

        root.querySelectorAll(".hm-option-row").forEach(row => {
            const key = row.dataset.key;
            const input = row.querySelector('input[type="range"]');
            input.addEventListener("input", () => {
                if (key === "priceMultiplier") HM.applyFoodstuffPriceMultiplier(input.value);
                else HM.setMarketSetting(key, key === "maxLot" ? HM.sliderToMaxLot(input.value) : input.value);
                refresh();
            });
            row.querySelectorAll("button[data-delta]").forEach(button => {
                button.addEventListener("click", () => {
                    const settings = HM.getMarketSettings();
                    if (key === "priceMultiplier") {
                        HM.applyFoodstuffPriceMultiplier(HM.getPriceMultiplier() + Number(button.dataset.delta));
                    } else {
                        HM.setMarketSetting(key, settings[key] + Number(button.dataset.delta));
                    }
                    refresh();
                });
            });
        });

        reset.addEventListener("click", () => {
            HM.resetMarketSettings();
            HM.applyFoodstuffPriceMultiplier(HM.config.priceMultiplier);
            refresh();
        });

        refresh();
        output.appendChild(root);
    };

    Macro.add("HonestMarkets_options", {
        handler() { HM.renderOptionsControl(this.output); }
    });

    HM.registerOptions = function () {
        if (HM._optionsRegistered) return true;
        if (!window.maplebirch?.tool?.addTo) return false;
        maplebirch.tool.addTo("Options", "HonestMarkets_options");
        HM._optionsRegistered = true;
        return true;
    };

    if (!HM.registerOptions()) {
        $(document).one(":passageinit.honestMarketsOptions", () => HM.registerOptions());
    }

    // setup.foodstuff 完成初始化後套用一次全局倍率；Options 變更時則會手動再次呼叫同一函式。
    $(document).one(":passageinit.honestMarketsPriceMultiplier", () => {
        HM.applyFoodstuffPriceMultiplier();
    });

    Macro.add("honestMarketsBegin", {
        handler() { HM.ensureVisit(); }
    });
    Macro.add("honestMarketsCategories", {
        handler() { new Wikifier(this.output, HM.renderCategories()); }
    });
    Macro.add("honestMarketsOffers", {
        handler() { new Wikifier(this.output, HM.renderOffers()); }
    });
    Macro.add("honestMarketsTheftAction", {
        handler() {
            const key = State.variables.honestMarketsCategory;
            new Wikifier(this.output, HM.renderTheftAction(key));
        }
    });
    Macro.add("honestMarketsSeeds", {
        handler() { new Wikifier(this.output, HM.renderSeeds()); }
    });
})();
