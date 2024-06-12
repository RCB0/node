const express = require('express');
const axios = require('axios');
const multer = require('multer');
const passport = require('passport');
const FacebookStrategy = require('passport-facebook').Strategy;
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const progress = require('progress-stream');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();
const app = express();
const PORT = 3000;

// Initialize HTTP server and socket.io
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files from the uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Parse URL-encoded bodies (as sent by HTML forms)
app.use(express.urlencoded({ extended: true }));

// Initialize multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
  }
});

// Initialize multer upload middleware
const upload = multer({ storage: storage });

// Initialize session middleware
app.use(session({ secret: 'secret', resave: false, saveUninitialized: true }));

// Initialize Passport and restore authentication state, if any, from the session
app.use(passport.initialize());
app.use(passport.session());

// Configure Passport to use Facebook Strategy
passport.use(new FacebookStrategy({
    clientID: process.env.FACEBOOK_APP_ID,
    clientSecret: process.env.FACEBOOK_APP_SECRET,
    callbackURL: 'http://localhost:3000/auth/facebook/callback'
  },
  (accessToken, refreshToken, profile, done) => {
    // Store user information and access token in session or database
    profile.accessToken = accessToken;
    return done(null, profile);
  }
));

// Serialize user object to store in session
passport.serializeUser((user, done) => {
  done(null, user);
});

// Deserialize user object from session
passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// Route for initiating authentication with Facebook
app.get('/auth/facebook',
  passport.authenticate('facebook'));

// Route for handling callback after Facebook authentication
app.get('/auth/facebook/callback',
  passport.authenticate('facebook', { failureRedirect: '/login' }),
  (req, res) => {
    // Successful authentication, redirect home
    res.redirect('/');
  });

// Middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/auth/facebook');
};

// Route for the home page
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>local or online storage</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
          a { text-decoration: none; color: #007bff; }
          a:hover { text-decoration: underline; }
        </style>
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();

          socket.on('uploadProgress', (data) => {
            const progressBar = document.getElementById('progressBar');
            progressBar.value = data.progress;
            progressBar.innerText = data.progress + '%';
          });
        </script>
      </head>
      <body>
        <h1>Welcome to the Facebook Data App</h1>
        <p><a href="/facebook-data">View Facebook Data</a></p>
        <h2>Upload a File</h2>
        <form action="/upload" method="post" enctype="multipart/form-data">
          <input type="file" name="file">
          <button type="submit">Upload</button>
        </form>
        <progress id="progressBar" value="0" max="100">0%</progress>
        <h2>Uploaded Files</h2>
        <ul>
          ${getUploadedFiles()}
        </ul>
      </body>
    </html>
  `);
});

// Route for viewing Facebook data
app.get('/facebook-data', isAuthenticated, async (req, res) => {
  try {
    // Fetch user data from Facebook API
    const response = await axios.get(`https://graph.facebook.com/me`, {
      params: {
        fields: 'id,name,picture',
        access_token: req.user.accessToken
      }
    });
    const userData = response.data;

    res.send(`
      <html>
        <head>
          <title>Facebook Data</title>
          <style>
            body { font-family: Arial, sans-serif; }
            .container { width: 50%; margin: 0 auto; text-align: center; }
            img { border-radius: 50%; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Facebook User Data</h1>
            <p><strong>Name:</strong> ${userData.name}</p>
            <p><strong>ID:</strong> ${userData.id}</p>
            <img src="${userData.picture.data.url}" alt="Profile Picture"/><br><br><br><br>
            <h2>Post to Facebook</h2>
        <form action="/post" method="post">
          <textarea name="content" placeholder="Enter your post content"></textarea><br>
          <button type="submit">Post</button>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error fetching Facebook data:', error.response ? error.response.data : error.message);
    res.status(500).send('An error occurred');
  }
});

// Route for handling file upload with progress tracking
app.post('/upload', isAuthenticated, (req, res, next) => {
  const progressStream = progress({ length: 'content-length', time: 100 });

  progressStream.on('progress', (progress) => {
    const progressPercentage = Math.round((progress.transferred / progress.length) * 100);
    io.emit('uploadProgress', { progress: progressPercentage });
  });

  // Bind the progress stream to the request and handle the file upload
  progressStream.headers = req.headers;
  req.pipe(progressStream);

  upload.single('file')(progressStream, res, (err) => {
    if (err) {
      return next(err);
    }
    res.redirect('/');
  });
});

// Function to get the list of uploaded files with linked images and iframes
function getUploadedFiles() {
  const uploadDir = path.join(__dirname, 'uploads');
  if (fs.existsSync(uploadDir)) {
    const files = fs.readdirSync(uploadDir);
    return files.map(file => `
      <li>
        <a href="/uploads/${file}" target="_blank">
          <img src="/uploads/${file}" alt="${file}" style="max-width: 40%; height: 40%;">
        </a>
        <form action="/delete/${file}" method="post">
          <button type="submit">Delete</button>
        </form>
        <form action="/rename/${file}" method="post">
          <input type="text" name="newName" placeholder="New Filename">
          <button type="submit">Rename</button>
        </form>
      </li>
    `).join('');
  } else {
    return '';
  }
}

// Route for deleting a file
app.post('/delete/:filename', isAuthenticated, (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(__dirname, 'uploads', filename);
  fs.unlinkSync(filePath);
  res.redirect('/');
});

// Route for renaming a file
app.post('/rename/:filename', isAuthenticated, (req, res) => {
  const { filename } = req.params;
  const { newName } = req.body;
  const oldFilePath = path.join(__dirname, 'uploads', filename);
  const newFilePath = path.join(__dirname, 'uploads', newName);
  fs.renameSync(oldFilePath, newFilePath);
  res.redirect('/');
});

// Route for handling post submission
app.post('/post', isAuthenticated, async (req, res) => {
  const { content } = req.body;
  console.log('Content:', content); // Log the content to the console

  try {
    // Post content to Facebook
    const response = await axios.post(`https://graph.facebook.com/me/feed`, {
      message: content,
      access_token: req.user.accessToken
    });
    console.log('Facebook API Response:', response.data); // Log the Facebook API response

    res.send(`
      <html>
        <head>
          <title>Post Successful</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
          </style>
        </head>
        <body>
          <h1>Post Successful</h1>
          <p>Your post has been successfully posted to Facebook.</p>
          <a href="/">Go back to home</a>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error posting to Facebook:', error.response ? error.response.data : error.message);
    res.status(500).send('An error occurred while posting to Facebook');
  }
});









//////////////////////////////////////////////
const firebase = require('firebase/app');
require('firebase/firestore'); // If using Firestore
require('firebase/database'); // If using Realtime Database

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyA6jBZpJAVCR86jfOJi02UwMIABFWSOgkw",
  authDomain: "online-filemanager.firebaseapp.com",
  projectId: "online-filemanager",
  storageBucket: "online-filemanager.appspot.com",
  messagingSenderId: "31774550495",
  appId: "1:31774550495:web:85f6a0c068d11edb2f3c6a",
  measurementId: "G-YHTELEP8JH"
};


firebase.initializeApp(firebaseConfig);

// For Firestore
const db = firebase.firestore();

// For Realtime Database
const database = firebase.database();
//////////////////////////////////////////

//////////////////////////////////////////////////









// Start the server
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
