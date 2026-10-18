const Redis = require('ioredis');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || null;
const REDIS_URL = process.env.REDIS_URL || null;

let client = null;
let isConnected = false;

function initRedis() {
    try {
        const config = REDIS_URL
            ? REDIS_URL
            : {
                  host: REDIS_HOST,
                  port: REDIS_PORT,
                  password: REDIS_PASSWORD || undefined,
                  maxRetriesPerRequest: 3,
                  retryStrategy(times) {
                      const delay = Math.min(times * 500, 3000);
                      return delay;
                  },
              };

        client = new Redis(config);

        client.on('connect', () => {
            isConnected = true;
            console.log(`[REDIS] Terhubung ke Redis server (${REDIS_HOST}:${REDIS_PORT})`);
        });

        client.on('ready', () => {
            isConnected = true;
        });

        client.on('error', (err) => {
            isConnected = false;
            console.error(`[REDIS] Error koneksi Redis: ${err.message}`);
        });

        client.on('close', () => {
            isConnected = false;
        });
    } catch (err) {
        console.error(`[REDIS] Gagal inisialisasi Redis: ${err.message}`);
    }
}

initRedis();

const redisService = {
    /**
     * Cek apakah Redis terhubung
     */
    isReady() {
        return isConnected && client && client.status === 'ready';
    },

    /**
     * Dapatkan instance client redis mentah
     */
    getClient() {
        return client;
    },

    /**
     * Kunci nominal untuk QRIS tertentu (Atomic Lock via SET ... NX EX)
     * @param {number} amount
     * @param {string} qrisId
     * @param {number} ttlSeconds Default: 60 detik (1 menit)
     * @returns {Promise<{ acquired: boolean, ttl: number }>}
     */
    async acquireAmountLock(amount, qrisId, ttlSeconds = 60) {
        if (!client || !isConnected) {
            console.warn('[REDIS] Redis tidak aktif, bypass atomic lock');
            return { acquired: true, ttl: ttlSeconds };
        }

        const key = `lock:amount:${amount}`;
        try {
            // SET key qrisId EX ttlSeconds NX
            // Return 'OK' jika berhasil lock, atau null jika sudah ada yang lock
            const result = await client.set(key, qrisId, 'EX', ttlSeconds, 'NX');

            if (result === 'OK') {
                return { acquired: true, ttl: ttlSeconds };
            }

            // Gagal lock -> ambil sisa TTL detik
            let remainingTtl = await client.ttl(key);
            if (remainingTtl < 0) remainingTtl = ttlSeconds;

            return { acquired: false, ttl: remainingTtl };
        } catch (err) {
            console.error(`[REDIS] Gagal acquireAmountLock: ${err.message}`);
            return { acquired: true, ttl: ttlSeconds };
        }
    },

    /**
     * Buka kunci nominal (dipanggil saat pembayaran PAID atau dibatalkan)
     * @param {number} amount
     */
    async releaseAmountLock(amount) {
        if (!client || !isConnected) return;
        const key = `lock:amount:${amount}`;
        try {
            await client.del(key);
            console.log(`[REDIS] Lock nominal Rp ${amount} berhasil dibuka.`);
        } catch (err) {
            console.error(`[REDIS] Gagal releaseAmountLock: ${err.message}`);
        }
    },

    /**
     * Simpan data QRIS ke Redis
     * @param {string} qrisId
     * @param {object} data
     * @param {number} ttlSeconds Default: 300 detik (5 menit penyimpanan data)
     */
    async saveQris(qrisId, data, ttlSeconds = 300) {
        if (!client || !isConnected) return;
        const key = `qris:${qrisId}`;
        try {
            await client.set(key, JSON.stringify(data), 'EX', ttlSeconds);
        } catch (err) {
            console.error(`[REDIS] Gagal saveQris: ${err.message}`);
        }
    },

    /**
     * Ambil data QRIS dari Redis
     * @param {string} qrisId
     * @returns {Promise<object|null>}
     */
    async getQris(qrisId) {
        if (!client || !isConnected) return null;
        const key = `qris:${qrisId}`;
        try {
            const data = await client.get(key);
            return data ? JSON.parse(data) : null;
        } catch (err) {
            console.error(`[REDIS] Gagal getQris: ${err.message}`);
            return null;
        }
    },

    /**
     * Update data QRIS di Redis
     * @param {string} qrisId
     * @param {object} updates
     */
    async updateQris(qrisId, updates) {
        if (!client || !isConnected) return;
        try {
            const current = await this.getQris(qrisId);
            if (current) {
                const updated = { ...current, ...updates };
                const ttl = await client.ttl(`qris:${qrisId}`);
                const keepTtl = ttl > 0 ? ttl : 300;
                await client.set(`qris:${qrisId}`, JSON.stringify(updated), 'EX', keepTtl);
            }
        } catch (err) {
            console.error(`[REDIS] Gagal updateQris: ${err.message}`);
        }
    },

    /**
     * Klaim transaksi mutasi Gojek agar tidak bisa diklaim ulang (TTL: 24 jam)
     * @param {string} txId
     * @param {string} qrisId
     * @param {number} ttlSeconds Default: 86400 (24 jam)
     * @returns {Promise<boolean>} True jika berhasil diklaim, False jika sudah diklaim transaksi lain
     */
    async claimTransaction(txId, qrisId, ttlSeconds = 86400) {
        if (!client || !isConnected) return true;
        const key = `claimed_tx:${txId}`;
        try {
            // SET key qrisId EX ttlSeconds NX
            const res = await client.set(key, qrisId, 'EX', ttlSeconds, 'NX');
            return res === 'OK';
        } catch (err) {
            console.error(`[REDIS] Gagal claimTransaction: ${err.message}`);
            return true;
        }
    },

    /**
     * Cek apakah transaksi sudah pernah diklaim
     * @param {string} txId
     * @returns {Promise<string|null>} qrisId pemilik klaim atau null jika belum diklaim
     */
    async getClaimedTransaction(txId) {
        if (!client || !isConnected) return null;
        const key = `claimed_tx:${txId}`;
        try {
            return await client.get(key);
        } catch (err) {
            console.error(`[REDIS] Gagal getClaimedTransaction: ${err.message}`);
            return null;
        }
    },
};

module.exports = redisService;
