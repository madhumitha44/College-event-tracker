require('dotenv').config();

const express = require('express');
const router = express.Router();
const { PutCommand, GetCommand, ScanCommand, QueryCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
const { SNSClient, SubscribeCommand, PublishCommand } = require("@aws-sdk/client-sns");
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../db');
const snsClient = new SNSClient({ region: process.env.AWS_REGION }); // e.g., "us-east-1"
const TOPIC_ARN = process.env.TOPIC_ARN; // Copy this from your AWS Console

// Table Names (Make sure these exist in your AWS Console)
const TABLES = {
    USERS: 'Users',
    EVENTS: 'Events',
    REGISTRATIONS: 'Registrations',
    CERTIFICATES: 'Certificates'
};

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================

// Register User
router.post('/auth/register', async (req, res) => {
    try {
        const { email, password, role, name, ...details } = req.body;

        // Check if user exists
        const checkUser = await db.send(new GetCommand({
            TableName: TABLES.USERS,
            Key: { email }
        }));

        if (checkUser.Item) {
            return res.status(400).json({ error: 'User already exists' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        const params = {
            TableName: TABLES.USERS,
            Item: {
                email,
                password: hashedPassword,
                role,
                name,
                details // Stores rollNo, college, etc.
            }
        };

        await db.send(new PutCommand(params));
        if (role === 'student') {
            try {
                await snsClient.send(new SubscribeCommand({
                    Protocol: 'email',
                    TopicArn: TOPIC_ARN,
                    Endpoint: email
                }));
                console.log(`Subscription request sent to ${email}`);
            } catch (snsErr) {
                console.error("SNS Subscribe Error:", snsErr);
                // We don't fail the whole registration if SNS fails
            }
        }

        res.status(201).json({ 
            message: 'User registered successfully. Students: Please check your email to confirm notifications!' 
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login User
router.post('/auth/login', async (req, res) => {
    try {
        const { email, password, role } = req.body;

        const result = await db.send(new GetCommand({
            TableName: TABLES.USERS,
            Key: { email }
        }));

        if (!result.Item) {
            return res.status(400).json({ error: 'User not found' });
        }

        if (result.Item.role !== role) {
            return res.status(400).json({ error: 'Invalid role for this user' });
        }

        const validPassword = await bcrypt.compare(password, result.Item.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Invalid password' });
        }

        // Don't send password back
        const { password: _, ...userData } = result.Item;
        res.json({ message: 'Login successful', user: userData });
    } catch (error) {
        res.status(500).json({ error: 'Login failed' });
    }
});

// ==========================================
// EVENT ROUTES
// ==========================================

// Create Event (Faculty)
router.post('/events', async (req, res) => {
    try {
        const eventId = `EVT-${Date.now()}`;
        const event = {
            eventId,
            ...req.body,
            created_at: new Date().toISOString()
        };

        await db.send(new PutCommand({
            TableName: TABLES.EVENTS,
            Item: event
        }));

        const notificationMessage = `
            📢 New Event Posted: ${event.name}
            📅 Date: ${event.date}
            ⏰ Time: ${event.time}
            📍 Venue: ${event.venue}
            
            Description: ${event.description}
            
            Log in to the portal to register now!
        `;
        
        try {
            await snsClient.send(new PublishCommand({
                TopicArn: TOPIC_ARN,
                Subject: `New Event: ${event.name}`,
                Message: notificationMessage
            }));
            console.log("Notification sent to SNS Topic");
        } catch (snsErr) {
            console.error("SNS Publish Error:", snsErr);
        }

        res.status(201).json({ message: 'Event created and notification sent', eventId });

    } catch (error) {
        res.status(500).json({ error: 'Could not create event' });
    }
});

router.post('/auth/update-profile', async (req, res) => {
    try {
        const { email, signature } = req.body;
        const user = await db.send(new GetCommand({ TableName: TABLES.USERS, Key: { email } }));

        if (!user.Item) return res.status(404).json({ error: "User not found" });

        await db.send(new PutCommand({
            TableName: TABLES.USERS,
            Item: { ...user.Item, signature }
        }));

        res.json({ message: "Profile updated" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get All Events (For Students)
router.get('/events', async (req, res) => {
    try {
        const eventsResult = await db.send(new ScanCommand({
            TableName: TABLES.EVENTS
        }));
        
        const events = eventsResult.Items || [];

        // Fetch counts for each event
        const eventsWithCounts = await Promise.all(events.map(async (event) => {
            const regResult = await db.send(new QueryCommand({
                TableName: TABLES.REGISTRATIONS,
                IndexName: 'EventIndex',
                KeyConditionExpression: 'eventId = :eventId',
                ExpressionAttributeValues: { ':eventId': event.eventId }
            }));
            
            return {
                ...event,
                currentParticipants: regResult.Items ? regResult.Items.length : 0
            };
        }));

        res.json(eventsWithCounts);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Could not fetch events with counts' });
    }
});

// Get Events by Faculty (For Faculty Dashboard)
router.get('/events/faculty/:email', async (req, res) => {
    try {
        const result = await db.send(new QueryCommand({
            TableName: TABLES.EVENTS,
            IndexName: 'FacultyIndex', // You must create this GSI in DynamoDB
            KeyConditionExpression: 'facultyEmail = :email',
            ExpressionAttributeValues: {
                ':email': req.params.email
            }
        }));
        res.json(result.Items);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Could not fetch faculty events' });
    }
});

// ==========================================
// REGISTRATION & ATTENDANCE ROUTES
// ==========================================

// Student Register for Event
router.post('/registrations', async (req, res) => {
    try {
        const { eventId, studentEmail, studentName } = req.body;

        // 1. Fetch Event details to get maxParticipants
        const eventResult = await db.send(new GetCommand({
            TableName: TABLES.EVENTS,
            Key: { eventId }
        }));
        const event = eventResult.Item;

        if (!event) return res.status(404).json({ error: 'Event not found' });

        // 2. Count current registrations for this event
        const regCountResult = await db.send(new QueryCommand({
            TableName: TABLES.REGISTRATIONS,
            IndexName: 'EventIndex',
            KeyConditionExpression: 'eventId = :eventId',
            ExpressionAttributeValues: { ':eventId': eventId }
        }));
        
        const currentCount = regCountResult.Items.length;
        const limit = parseInt(event.maxParticipants) || Infinity;

        // 3. Check if limit is reached
        if (currentCount >= limit) {
            return res.status(400).json({ error: 'Event is full! Maximum capacity reached.' });
        }

        const registrationId = `REG-${uuidv4()}`;
        const registration = {
            registrationId,
            attendanceMarked: false,
            registrationDate: new Date().toISOString(),
            ...req.body 
        };

        await db.send(new PutCommand({
            TableName: TABLES.REGISTRATIONS,
            Item: registration
        }));

        res.status(201).json({ message: 'Registered successfully', registrationId });
    } catch (error) {
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Get Registrations by Student
// Get Student Registrations with Event Names
router.get('/registrations/student/:email', async (req, res) => {
    try {
        // 1. Fetch all registrations for the student
        const regResult = await db.send(new QueryCommand({
            TableName: TABLES.REGISTRATIONS,
            IndexName: 'StudentIndex', // Ensure GSI on studentEmail exists
            KeyConditionExpression: 'studentEmail = :email',
            ExpressionAttributeValues: { ':email': req.params.email }
        }));

        const registrations = regResult.Items || [];

        // 2. Enrich each registration with the actual Event Name
        const enrichedRegistrations = await Promise.all(registrations.map(async (reg) => {
            try {
                const eventResult = await db.send(new GetCommand({
                    TableName: TABLES.EVENTS,
                    Key: { eventId: reg.eventId }
                }));
                
                return {
                    ...reg,
                    eventName: eventResult.Item ? eventResult.Item.name : "Unknown Event"
                };
            } catch (err) {
                return { ...reg, eventName: "Event Info N/A" };
            }
        }));

        res.json(enrichedRegistrations);
    } catch (error) {
        console.error('Error fetching enriched registrations:', error);
        res.status(500).json({ error: 'Could not fetch registrations' });
    }
});

// Get all registrations for a specific event (used to populate student dropdown)
router.get('/registrations/event/:eventId', async (req, res) => {
    try {
        const { eventId } = req.params; // Get ID from the URL
        
        const result = await db.send(new QueryCommand({
            TableName: TABLES.REGISTRATIONS,
            IndexName: 'EventIndex', 
            KeyConditionExpression: 'eventId = :eid', // Using :eid as the placeholder
            ExpressionAttributeValues: { 
                ':eid': eventId // Mapping the actual eventId to :eid
            }
        }));
        
        console.log(`Found ${result.Items.length} students for event ${eventId}`);
        res.json(result.Items || []);
    } catch (error) {
        console.error("Error fetching students:", error);
        res.status(500).json({ error: 'Could not fetch students' });
    }
});

// Mark Attendance
router.post('/attendance/mark', async (req, res) => {
    try {
        const { registrationId } = req.body;
        
        // We use UpdateCommand to modify just one field
        const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
        
        await db.send(new UpdateCommand({
            TableName: TABLES.REGISTRATIONS,
            Key: { registrationId },
            UpdateExpression: "set attendanceMarked = :status, attendanceTime = :time",
            ExpressionAttributeValues: {
                ":status": true,
                ":time": new Date().toISOString()
            }
        }));

        res.json({ message: 'Attendance marked' });
    } catch (error) {
        res.status(500).json({ error: 'Could not mark attendance' });
    }
});

// ==========================================
// CERTIFICATE ROUTES
// ==========================================

// Issue Certificate (Metadata only - Files should ideally go to S3)
router.post('/certificates', async (req, res) => {
    try {
        const certificateId = `CERT-${uuidv4()}`;
        const item = {
            certificateId,
            issueDate: new Date().toISOString(),
            ...req.body
        };

        await db.send(new PutCommand({
            TableName: TABLES.CERTIFICATES,
            Item: item
        }));

        res.status(201).json({ message: 'Certificate issued', certificateId });
    } catch (error) {
        res.status(500).json({ error: 'Certificate issuance failed' });
    }
});

// Get Student Certificates
// Get Student Certificates with Event Names
router.get('/certificates/student/:email', async (req, res) => {
    try {
        // 1. Get all certificates for the student
        const certResult = await db.send(new QueryCommand({
            TableName: TABLES.CERTIFICATES,
            IndexName: 'StudentIndex',
            KeyConditionExpression: 'studentEmail = :email',
            ExpressionAttributeValues: { ':email': req.params.email }
        }));

        const certificates = certResult.Items || [];

        // 2. Enrich certificates with Event Names AND Faculty Email
        const enrichedCertificates = await Promise.all(certificates.map(async (cert) => {
            try {
                // Fetch the event linked to this certificate
                const eventResult = await db.send(new GetCommand({
                    TableName: TABLES.EVENTS,
                    Key: { eventId: cert.eventId }
                }));
                
                const event = eventResult.Item;

                return {
                    ...cert,
                    eventName: event ? event.name : "Unknown Event",
                    facultyEmail: event ? event.facultyEmail : "N/A" // ADDED THIS LINE
                };
            } catch (err) {
                return { 
                    ...cert, 
                    eventName: "Event Details Unavailable",
                    facultyEmail: "N/A" 
                };
            }
        }));

        res.json(enrichedCertificates);
    } catch (error) {
        console.error('Error fetching enriched certificates:', error);
        res.status(500).json({ error: 'Could not fetch certificates' });
    }
});

// ==========================================
// REGISTRATION ROUTES (ADD THESE)
// ==========================================

// Get single registration details (used by Faculty before issuing certificate)
router.get('/registrations/:id', async (req, res) => {
    try {
        const result = await db.send(new GetCommand({
            TableName: TABLES.REGISTRATIONS,
            Key: { registrationId: req.params.id }
        }));
        
        if (!result.Item) {
            return res.status(404).json({ error: 'Registration not found' });
        }
        res.json(result.Item);
    } catch (error) {
        res.status(500).json({ error: 'Could not fetch registration details' });
    }
});

// Mark Attendance Manually
router.post('/registrations/mark-attendance', async (req, res) => {
    try {
        const { registrationId } = req.body;

        // 1. First, check if the registration exists
        const checkResult = await db.send(new GetCommand({
            TableName: TABLES.REGISTRATIONS,
            Key: { registrationId }
        }));

        if (!checkResult.Item) {
            return res.status(404).json({ error: 'Registration record not found.' });
        }

        // 2. If it exists, update the attendance
        await db.send(new PutCommand({
            TableName: TABLES.REGISTRATIONS,
            Item: {
                ...checkResult.Item, // Keep existing data (studentEmail, eventId, etc.)
                attendanceMarked: true,
                attendanceTime: new Date().toISOString()
            }
        }));

        res.json({ message: 'Attendance marked successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get User details by email (To fetch Faculty signature for certificates)
router.get('/auth/user/:email', async (req, res) => {
    try {
        const result = await db.send(new GetCommand({
            TableName: TABLES.USERS,
            Key: { email: req.params.email }
        }));

        if (!result.Item) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Return only necessary info (Name, Role, and Signature)
        const { password, ...publicData } = result.Item;
        res.json(publicData);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Could not fetch user details' });
    }
});

// Get Detailed Event Report for Faculty
router.get('/events/report/:facultyEmail', async (req, res) => {
    try {
        const { facultyEmail } = req.params;

        // 1. Fetch all events by this faculty
        const eventsResult = await db.send(new QueryCommand({
            TableName: TABLES.EVENTS,
            IndexName: 'FacultyIndex',
            KeyConditionExpression: 'facultyEmail = :email',
            ExpressionAttributeValues: { ':email': facultyEmail }
        }));

        const events = eventsResult.Items || [];

        // 2. For each event, get registration and attendance counts
        const reportData = await Promise.all(events.map(async (event) => {
            const registrations = await db.send(new QueryCommand({
                TableName: TABLES.REGISTRATIONS,
                IndexName: 'EventIndex',
                KeyConditionExpression: 'eventId = :eventId',
                ExpressionAttributeValues: { ':eventId': event.eventId }
            }));

            const totalJoined = registrations.Items ? registrations.Items.length : 0;
            const totalAttended = registrations.Items ? 
                registrations.Items.filter(r => r.attendanceMarked === true).length : 0;

            return {
                eventName: event.name,
                date: event.date,
                location: event.venue,
                maxCapacity: event.maxParticipants || 'N/A',
                totalJoined: totalJoined,
                totalAttended: totalAttended,
                attendanceRate: totalJoined > 0 ? ((totalAttended / totalJoined) * 100).toFixed(2) + '%' : '0%'
            };
        }));

        res.json(reportData);
    } catch (error) {
        console.error("Report Error:", error);
        res.status(500).json({ error: 'Could not generate report' });
    }
});



module.exports = router;