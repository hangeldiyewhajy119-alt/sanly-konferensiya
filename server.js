const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '3mb' })); // suratlar (avatar) üçin ýokarlandyrylan limit
app.use(express.static(path.join(__dirname, 'public')));

// ---- MongoDB baglanyşygy ----
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'sanly-konferensiya-gizlin-acar-2026';

let meetingsCollection = null;
let usersCollection = null;
let historyCollection = null;
let messagesCollection = null;

async function connectDB() {
    if (!MONGODB_URI) {
        console.log('MONGODB_URI environment variable tapylmady — duşuşyklar hakydada (memory) saklanar.');
        return;
    }
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        const db = client.db('sanly_konferensiya');
        meetingsCollection = db.collection('meetings');
        usersCollection = db.collection('users');
        historyCollection = db.collection('history');
        messagesCollection = db.collection('messages');
        await usersCollection.createIndex({ email: 1 }, { unique: true });
        console.log('MongoDB-e üstünlikli baglanyldy.');
    } catch (err) {
        console.error('MongoDB baglanyşyk ýalňyşlygy:', err.message);
    }
}
connectDB();

// Eger MongoDB elýeterli bolmasa, ätiýaçlyk hökmünde hakydada saklamak
let meetingsMemory = [];

function makePermanentRoomId() {
    return 'otag-' + crypto.randomBytes(4).toString('hex');
}

function publicUser(u) {
    return {
        id: u._id.toString(),
        name: u.name,
        email: u.email,
        avatar: u.avatar || null,
        permanentRoomId: u.permanentRoomId
    };
}

// ---- Ulanyjy Barlagy (Auth Middleware) ----
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Giriş talap edilýär' });
    }
    const token = authHeader.split(' ')[1];
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Nädogry ýa-da möhleti geçen giriş' });
    }
}

// ---- Hasaba Durmak (Register) ----
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password } = req.body || {};

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Ähli meýdanlary dolduryň' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Parol azyndan 6 harp bolmaly' });
        }
        if (!usersCollection) {
            return res.status(503).json({ error: 'Ulgam wagtlaýyn elýeterli däl. Birazdan täzeden synanyşyň.' });
        }

        const normalizedEmail = email.toLowerCase().trim();
        const existing = await usersCollection.findOne({ email: normalizedEmail });
        if (existing) {
            return res.status(409).json({ error: 'Bu email bilen eýýäm hasap bar' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const permanentRoomId = makePermanentRoomId();
        const result = await usersCollection.insertOne({
            name,
            email: normalizedEmail,
            passwordHash,
            avatar: null,
            permanentRoomId,
            createdAt: new Date()
        });

        const userDoc = { _id: result.insertedId, name, email: normalizedEmail, avatar: null, permanentRoomId };
        const token = jwt.sign(
            { id: result.insertedId.toString(), name, email: normalizedEmail },
            JWT_SECRET,
            { expiresIn: '30d' }
        );
        res.status(201).json({ token, user: publicUser(userDoc) });
    } catch (err) {
        console.error('Registrasiýa ýalňyşlygy:', err.message);
        res.status(500).json({ error: 'Hasap döredilip bilmedi' });
    }
});

// ---- Giriş (Login) ----
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};

        if (!email || !password) {
            return res.status(400).json({ error: 'Email we paroly giriziň' });
        }
        if (!usersCollection) {
            return res.status(503).json({ error: 'Ulgam wagtlaýyn elýeterli däl. Birazdan täzeden synanyşyň.' });
        }

        const normalizedEmail = email.toLowerCase().trim();
        const user = await usersCollection.findOne({ email: normalizedEmail });
        if (!user) {
            return res.status(401).json({ error: 'Email ýa-da parol nädogry' });
        }

        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) {
            return res.status(401).json({ error: 'Email ýa-da parol nädogry' });
        }

        // Köne hasaplarda hemişelik otag ýok bolsa, häzir dörediň
        if (!user.permanentRoomId) {
            user.permanentRoomId = makePermanentRoomId();
            await usersCollection.updateOne({ _id: user._id }, { $set: { permanentRoomId: user.permanentRoomId } });
        }

        const token = jwt.sign(
            { id: user._id.toString(), name: user.name, email: user.email },
            JWT_SECRET,
            { expiresIn: '30d' }
        );
        res.json({ token, user: publicUser(user) });
    } catch (err) {
        console.error('Giriş ýalňyşlygy:', err.message);
        res.status(500).json({ error: 'Giriş edip bolmady' });
    }
});

// ---- Häzirki Ulanyjy (Me) ----
app.get('/api/me', authMiddleware, async (req, res) => {
    try {
        if (!usersCollection) return res.status(503).json({ error: 'Ulgam wagtlaýyn elýeterli däl' });
        const user = await usersCollection.findOne({ _id: new ObjectId(req.user.id) });
        if (!user) return res.status(404).json({ error: 'Ulanyjy tapylmady' });
        res.json({ user: publicUser(user) });
    } catch (err) {
        res.status(500).json({ error: 'Maglumat alnyp bilmedi' });
    }
});

// ---- Profili Täzelemek (at we/ýa-da surat) ----
app.put('/api/profile', authMiddleware, async (req, res) => {
    try {
        if (!usersCollection) return res.status(503).json({ error: 'Ulgam wagtlaýyn elýeterli däl' });
        const { name, avatar } = req.body || {};
        const update = {};
        if (typeof name === 'string' && name.trim()) update.name = name.trim();
        if (typeof avatar === 'string') update.avatar = avatar; // base64 data URL

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ error: 'Üýtgetjek zadyňyzy giriziň' });
        }

        await usersCollection.updateOne({ _id: new ObjectId(req.user.id) }, { $set: update });
        const user = await usersCollection.findOne({ _id: new ObjectId(req.user.id) });
        res.json({ user: publicUser(user) });
    } catch (err) {
        console.error('Profil täzelemek ýalňyşlygy:', err.message);
        res.status(500).json({ error: 'Profil täzelenip bilmedi' });
    }
});

// ---- Duşuşyk Taryhy ----
app.post('/api/history', authMiddleware, async (req, res) => {
    try {
        if (!historyCollection) return res.status(503).json({ error: 'Ulgam wagtlaýyn elýeterli däl' });
        const { roomId } = req.body || {};
        if (!roomId) return res.status(400).json({ error: 'roomId gerek' });

        await historyCollection.insertOne({
            userId: req.user.id,
            roomId,
            joinedAt: new Date()
        });
        res.status(201).json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Taryh ýazylyp bilmedi' });
    }
});

app.get('/api/history', authMiddleware, async (req, res) => {
    try {
        if (!historyCollection) return res.json([]);
        const items = await historyCollection
            .find({ userId: req.user.id })
            .sort({ joinedAt: -1 })
            .limit(50)
            .toArray();
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: 'Taryh alnyp bilmedi' });
    }
});

// ---- Ulanyjylaryň Sanawy (Habarlaşmak üçin) ----
app.get('/api/users', authMiddleware, async (req, res) => {
    try {
        if (!usersCollection) return res.json([]);
        const users = await usersCollection
            .find({ _id: { $ne: new ObjectId(req.user.id) } })
            .project({ passwordHash: 0 })
            .toArray();
        res.json(users.map(publicUser));
    } catch (err) {
        res.status(500).json({ error: 'Ulanyjylar alnyp bilmedi' });
    }
});

// ---- Iki ulanyjynyň arasyndaky habarlar taryhy ----
app.get('/api/messages/:userId', authMiddleware, async (req, res) => {
    try {
        if (!messagesCollection) return res.json([]);
        const myId = req.user.id;
        const otherId = req.params.userId;
        const messages = await messagesCollection.find({
            $or: [
                { fromUserId: myId, toUserId: otherId },
                { fromUserId: otherId, toUserId: myId }
            ]
        }).sort({ createdAt: 1 }).limit(200).toArray();
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: 'Habarlar alnyp bilmedi' });
    }
});

// ---- Duşuşyklary Meýilleşdirmek (API) ----

app.get('/api/meetings', async (req, res) => {
    try {
        if (meetingsCollection) {
            const meetings = await meetingsCollection.find({}).sort({ _id: -1 }).toArray();
            return res.json(meetings);
        }
        res.json(meetingsMemory);
    } catch (err) {
        console.error('Duşuşyklary almakda ýalňyşlyk:', err.message);
        res.status(500).json({ error: 'Duşuşyklar ýüklenip bilmedi' });
    }
});

app.post('/api/meetings', async (req, res) => {
    try {
        const { title, roomId, date, time, organizerName } = req.body || {};

        if (!title || !roomId || !date || !time) {
            return res.status(400).json({ error: 'Maglumatlar doly däl' });
        }

        const newMeeting = {
            id: Date.now().toString(),
            title,
            roomId,
            date,
            time,
            organizerName: organizerName || 'Näbelli'
        };

        if (meetingsCollection) {
            await meetingsCollection.insertOne(newMeeting);
        } else {
            meetingsMemory.push(newMeeting);
        }

        res.status(201).json(newMeeting);
    } catch (err) {
        console.error('Duşuşyk döretmekde ýalňyşlyk:', err.message);
        res.status(500).json({ error: 'Duşuşyk döredilip bilmedi' });
    }
});

// Otaglaryň içindäki ulanyjylary ýatda saklamak: { roomId: { socketId: { name, audio, video } } }
const rooms = {};

io.on('connection', (socket) => {
    let currentRoom = null;
    let currentUserName = null;
    socket.userId = null; // giren ulanyjynyň hasap ID-si (bar bolsa)

    // Ulanyjyny giren hasaby bilen baglanyşdyrmak (habarlaşmak we taryh üçin)
    socket.on('authenticate', (token) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            socket.userId = decoded.id;
            socket.join('user-' + decoded.id);
        } catch (err) {
            // token nädogry bolsa, ünsi almaýarys — anon hökmünde dowam edýär
        }
    });

    // Şahsy Habarlaşma (Messaging)
    socket.on('send-dm', async ({ toUserId, text }) => {
        if (!socket.userId || !text || !toUserId) return;
        const message = {
            fromUserId: socket.userId,
            toUserId,
            text,
            createdAt: new Date()
        };
        if (messagesCollection) {
            await messagesCollection.insertOne(message);
        }
        io.to('user-' + toUserId).emit('receive-dm', message);
        socket.emit('receive-dm', message); // iberijiniň öz ekranynda-da görünsin
    });

    // Ulanyjy otaga girende
    socket.on('join-room', async ({ roomId, userName }) => {
        currentRoom = roomId;
        currentUserName = userName;

        socket.join(roomId);

        if (!rooms[roomId]) rooms[roomId] = {};

        const existingUsers = Object.entries(rooms[roomId]).map(([id, info]) => ({
            id, name: info.name, audio: info.audio, video: info.video
        }));
        socket.emit('existing-users', existingUsers);

        rooms[roomId][socket.id] = { name: userName, audio: true, video: true };
        socket.to(roomId).emit('user-joined', { id: socket.id, name: userName, audio: true, video: true });

        // Giren hasaby üçin duşuşyk taryhyny ýazmak
        if (socket.userId && historyCollection) {
            try {
                await historyCollection.insertOne({ userId: socket.userId, roomId, joinedAt: new Date() });
            } catch (err) {
                console.error('Taryh ýazmak ýalňyşlygy:', err.message);
            }
        }
    });

    socket.on('offer', ({ to, offer }) => {
        io.to(to).emit('offer', { from: socket.id, offer });
    });

    socket.on('answer', ({ to, answer }) => {
        io.to(to).emit('answer', { from: socket.id, answer });
    });

    socket.on('ice-candidate', ({ to, candidate }) => {
        io.to(to).emit('ice-candidate', { from: socket.id, candidate });
    });

    socket.on('chat-message', ({ text }) => {
        if (!currentRoom) return;
        io.to(currentRoom).emit('chat-message', {
            senderId: socket.id,
            senderName: currentUserName,
            text
        });
    });

    socket.on('raise-hand', ({ raised }) => {
        if (!currentRoom) return;
        socket.to(currentRoom).emit('raise-hand', { id: socket.id, raised });
    });

    socket.on('media-state', ({ audio, video }) => {
        if (!currentRoom) return;
        if (rooms[currentRoom] && rooms[currentRoom][socket.id]) {
            rooms[currentRoom][socket.id].audio = audio;
            rooms[currentRoom][socket.id].video = video;
        }
        socket.to(currentRoom).emit('media-state', { id: socket.id, audio, video });
    });

    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            delete rooms[currentRoom][socket.id];
            socket.to(currentRoom).emit('user-left', { id: socket.id });

            if (Object.keys(rooms[currentRoom]).length === 0) {
                delete rooms[currentRoom];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serwer işleýär: http://localhost:${PORT}`);
});
