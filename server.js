const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- MongoDB baglanyşygy ----
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'sanly-konferensiya-gizlin-acar-2026';

let meetingsCollection = null;
let usersCollection = null;

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
        await usersCollection.createIndex({ email: 1 }, { unique: true });
        console.log('MongoDB-e üstünlikli baglanyldy.');
    } catch (err) {
        console.error('MongoDB baglanyşyk ýalňyşlygy:', err.message);
    }
}
connectDB();

// Eger MongoDB elýeterli bolmasa, ätiýaçlyk hökmünde hakydada saklamak
let meetingsMemory = [];

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
        const result = await usersCollection.insertOne({
            name,
            email: normalizedEmail,
            passwordHash,
            createdAt: new Date()
        });

        const token = jwt.sign(
            { id: result.insertedId.toString(), name, email: normalizedEmail },
            JWT_SECRET,
            { expiresIn: '30d' }
        );
        res.status(201).json({ token, user: { name, email: normalizedEmail } });
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

        const token = jwt.sign(
            { id: user._id.toString(), name: user.name, email: user.email },
            JWT_SECRET,
            { expiresIn: '30d' }
        );
        res.json({ token, user: { name: user.name, email: user.email } });
    } catch (err) {
        console.error('Giriş ýalňyşlygy:', err.message);
        res.status(500).json({ error: 'Giriş edip bolmady' });
    }
});

// ---- Häzirki Ulanyjy (Me) ----
app.get('/api/me', authMiddleware, (req, res) => {
    res.json({ user: { name: req.user.name, email: req.user.email } });
});

// ---- Duşuşyklary Meýilleşdirmek (API) ----

// Ähli meýilleşdirilen duşuşyklaryň sanawyny almak
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

// Täze duşuşyk meýilleşdirmek
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

    // Ulanyjy otaga girende
    socket.on('join-room', ({ roomId, userName }) => {
        currentRoom = roomId;
        currentUserName = userName;

        socket.join(roomId);

        if (!rooms[roomId]) rooms[roomId] = {};

        // Otagda öňden bar bolan ulanyjylaryň sanawyny (at + ses/wideo ýagdaýy) täze goşulan adama ibermek
        const existingUsers = Object.entries(rooms[roomId]).map(([id, info]) => ({
            id, name: info.name, audio: info.audio, video: info.video
        }));
        socket.emit('existing-users', existingUsers);

        // Täze ulanyjyny otagdaky beýlekilere habar bermek (başlangyçda mikrofon/kamera açyk hasaplanýar)
        rooms[roomId][socket.id] = { name: userName, audio: true, video: true };
        socket.to(roomId).emit('user-joined', { id: socket.id, name: userName, audio: true, video: true });
    });

    // WebRTC signal alyş-çalyşy (offer / answer / ice-candidate)
    socket.on('offer', ({ to, offer }) => {
        io.to(to).emit('offer', { from: socket.id, offer });
    });

    socket.on('answer', ({ to, answer }) => {
        io.to(to).emit('answer', { from: socket.id, answer });
    });

    socket.on('ice-candidate', ({ to, candidate }) => {
        io.to(to).emit('ice-candidate', { from: socket.id, candidate });
    });

    // Çat hatlary
    socket.on('chat-message', ({ text }) => {
        if (!currentRoom) return;
        io.to(currentRoom).emit('chat-message', {
            senderId: socket.id,
            senderName: currentUserName,
            text
        });
    });

    // Eliňi götermek
    socket.on('raise-hand', ({ raised }) => {
        if (!currentRoom) return;
        socket.to(currentRoom).emit('raise-hand', { id: socket.id, raised });
    });

    // Kamera/mikrofon ýagdaýyny beýlekilere habar bermek (we otagyň ýadynda-da täzelemek)
    socket.on('media-state', ({ audio, video }) => {
        if (!currentRoom) return;
        if (rooms[currentRoom] && rooms[currentRoom][socket.id]) {
            rooms[currentRoom][socket.id].audio = audio;
            rooms[currentRoom][socket.id].video = video;
        }
        socket.to(currentRoom).emit('media-state', { id: socket.id, audio, video });
    });

    // Ulanyjy çykanda ýa-da baglanyşyk üzülende
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
