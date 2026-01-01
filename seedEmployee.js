// seedEmployeeSessions.js
const mongoose = require('mongoose');
const EmployeeSession = require('./src/models/EmployeeSession');

const MONGO_URI = 'mongodb+srv://abdullahahmedqureshint:2zrm6dbPHMaVqwpL@cluster0.lcln8dt.mongodb.net/customLocal'; // Update with your DB URI

// Employee ID to seed data for
const EMPLOYEE_ID = '68b1610b482495e0314e4386';

// Office timing: 3:00 PM to 12:00 AM (next day)
const OFFICE_START_HOUR = 15; // 3 PM
const GRACE_PERIOD_END = 15 * 60 + 15; // 3:15 PM in minutes
const HALF_DAY_THRESHOLD = 18 * 60; // 6:00 PM in minutes
const HALF_DAY_LOGOUT_THRESHOLD = 21 * 60; // 9:00 PM in minutes

// Function to generate random time within a range
function randomTime(minHour, minMinute, maxHour, maxMinute) {
  const totalMinutesStart = minHour * 60 + minMinute;
  const totalMinutesEnd = maxHour * 60 + maxMinute;
  const randomMinutes = Math.floor(Math.random() * (totalMinutesEnd - totalMinutesStart + 1)) + totalMinutesStart;
  
  const hour = Math.floor(randomMinutes / 60);
  const minute = randomMinutes % 60;
  
  return {
    hour,
    minute,
    formatted: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
}

// Function to generate logout time (mostly 12 AM, sometimes between 11:30 PM - 12:30 AM)
function generateLogoutTime() {
  // 70% chance of exactly 12:00 AM
  if (Math.random() < 0.7) {
    return {
      hour: 0, // 12 AM
      minute: 0,
      formatted: '00:00'
    };
  }
  
  // 30% chance: between 11:30 PM - 12:30 AM
  const randomMinutes = Math.floor(Math.random() * 121) - 30; // -30 to +90 minutes from midnight
  const totalMinutes = 24 * 60 + randomMinutes; // Start from midnight
  
  let hour = Math.floor(totalMinutes / 60) % 24;
  let minute = totalMinutes % 60;
  
  // Adjust for proper 24-hour format
  if (hour === 24) hour = 0;
  
  return {
    hour,
    minute,
    formatted: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
}

// Function to calculate status based on login time
function calculateLoginStatus(loginHour, loginMinute) {
  const totalMinutes = loginHour * 60 + loginMinute;
  
  if (totalMinutes < OFFICE_START_HOUR * 60) {
    return 'on-time';
  } else if (totalMinutes <= GRACE_PERIOD_END) {
    return 'on-time';
  } else if (totalMinutes < HALF_DAY_THRESHOLD) {
    return 'late';
  } else {
    return 'half-day';
  }
}

// Function to generate random sessions for January 2026
async function seedSessions() {
  try {
    // Connect to MongoDB
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    // Clear existing sessions for this employee in January 2026
    await EmployeeSession.deleteMany({
      employeeId: EMPLOYEE_ID,
      date: { $regex: '^2026-01-' }
    });
    console.log('Cleared existing sessions for Jan 2026');

    const sessions = [];
    const startDate = new Date('2026-01-01');
    const endDate = new Date('2026-01-31');

    // Define attendance patterns
    const attendancePattern = [
      'on-time', 'on-time', 'late', 'on-time', 'on-time', 
      'half-day', 'on-time', 'late', 'on-time', 'on-time',
      'leave', 'on-time', 'late', 'absent', 'on-time',
      'on-time', 'half-day', 'on-time', 'on-time', 'late',
      'on-time', 'leave', 'on-time', 'on-time', 'late',
      'half-day', 'on-time', 'on-time', 'on-time', 'absent',
      'on-time'
    ];

    for (let date = new Date(startDate); date <= endDate; date.setDate(date.getDate() + 1)) {
      const dateStr = date.toISOString().split('T')[0];
      const dayOfMonth = date.getDate();
      const dayOfWeek = date.getDay();
      
      // Skip weekends (Saturday=6, Sunday=0)
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        // Weekend - mark as absent or leave randomly
        const status = Math.random() > 0.7 ? 'leave' : 'absent';
        
        sessions.push({
          employeeId: EMPLOYEE_ID,
          date: dateStr,
          status: status,
          active: false,
          loginTime: null,
          logoutTime: null,
          deviceFingerprint: `seed_${dateStr}`,
          actualLoginTime: null,
          actualLogoutTime: null,
          totalHours: 0,
          isAutoLogout: false,
          isLoginAfter6PM: false,
        });
        continue;
      }

      // Get status from pattern or random
      let status;
      if (dayOfMonth - 1 < attendancePattern.length) {
        status = attendancePattern[dayOfMonth - 1];
      } else {
        // Random distribution for remaining days
        const rand = Math.random();
        if (rand < 0.6) status = 'on-time';
        else if (rand < 0.8) status = 'late';
        else if (rand < 0.9) status = 'half-day';
        else if (rand < 0.95) status = 'leave';
        else status = 'absent';
      }

      // Handle leave and absent days (no login/logout)
      if (status === 'leave' || status === 'absent') {
        sessions.push({
          employeeId: EMPLOYEE_ID,
          date: dateStr,
          status: status,
          active: false,
          loginTime: null,
          logoutTime: null,
          deviceFingerprint: `seed_${dateStr}`,
          actualLoginTime: null,
          actualLogoutTime: null,
          totalHours: 0,
          isAutoLogout: false,
          isLoginAfter6PM: false,
        });
        continue;
      }

      // Generate login time based on status
      let loginTime;
      let isLoginAfter6PM = false;

      switch (status) {
        case 'on-time':
          // Between 2:45 PM and 3:15 PM
          loginTime = randomTime(14, 45, 15, 15);
          break;
        case 'late':
          // Between 3:16 PM and 5:59 PM
          loginTime = randomTime(15, 16, 17, 59);
          break;
        case 'half-day':
          // Between 6:00 PM and 11:00 PM
          loginTime = randomTime(18, 0, 23, 0);
          isLoginAfter6PM = true;
          break;
      }

      // Generate logout time (mostly 12 AM)
      const logoutTime = generateLogoutTime();
      
      // Calculate total hours worked
      const loginTotalMinutes = loginTime.hour * 60 + loginTime.minute;
      let logoutTotalMinutes = logoutTime.hour * 60 + logoutTime.minute;
      
      // If logout is after midnight (0:00 to 12:30 AM), add 24 hours
      if (logoutTotalMinutes < 12 * 60) { // Before 12 PM (noon)
        logoutTotalMinutes += 24 * 60; // Add 24 hours
      }
      
      const totalHours = (logoutTotalMinutes - loginTotalMinutes) / 60;

      // Create login and logout Date objects
      const loginDateTime = new Date(`2026-01-${String(dayOfMonth).padStart(2, '0')}T${loginTime.formatted}:00`);
      let logoutDateTime;
      
      if (logoutTime.hour < 12) {
        // Logout is after midnight (next day)
        logoutDateTime = new Date(`2026-01-${String(dayOfMonth + 1).padStart(2, '0')}T${logoutTime.formatted}:00`);
      } else {
        // Logout is on same day
        logoutDateTime = new Date(`2026-01-${String(dayOfMonth).padStart(2, '0')}T${logoutTime.formatted}:00`);
      }

      // Calculate final status based on logout time
      let finalStatus = status;
      
      // Check if logout before 9:00 PM (21:00)
      let logoutHourCheck = logoutTime.hour;
      if (logoutHourCheck < 12) logoutHourCheck += 24; // Convert AM to 24-hour
      
      if (logoutHourCheck < 21) { // Before 9:00 PM
        finalStatus = 'half-day';
      }

      sessions.push({
        employeeId: EMPLOYEE_ID,
        date: dateStr,
        status: finalStatus,
        active: false,
        loginTime: loginDateTime,
        logoutTime: logoutDateTime,
        deviceFingerprint: `seed_${dateStr}`,
        actualLoginTime: loginTime.formatted,
        actualLogoutTime: logoutTime.formatted,
        totalHours: parseFloat(totalHours.toFixed(2)),
        isAutoLogout: Math.random() > 0.9, // 10% chance of auto-logout
        isLoginAfter6PM: isLoginAfter6PM,
      });
    }

    // Insert all sessions
    const result = await EmployeeSession.insertMany(sessions);
    console.log(`Seeded ${result.length} sessions for employee ${EMPLOYEE_ID}`);

    // Print summary
    const summary = {
      'on-time': sessions.filter(s => s.status === 'on-time').length,
      'late': sessions.filter(s => s.status === 'late').length,
      'half-day': sessions.filter(s => s.status === 'half-day').length,
      'leave': sessions.filter(s => s.status === 'leave').length,
      'absent': sessions.filter(s => s.status === 'absent').length,
      'with-logout': sessions.filter(s => s.logoutTime !== null).length,
      'active-false': sessions.filter(s => s.active === false).length,
    };
    console.log('Attendance Summary:', summary);

    // Print sample of logout times
    const sampleSessions = sessions.slice(0, 10);
    console.log('\nSample Sessions (first 10):');
    sampleSessions.forEach((s, i) => {
      if (s.actualLoginTime && s.actualLogoutTime) {
        console.log(`${i+1}. Date: ${s.date}, Login: ${s.actualLoginTime}, Logout: ${s.actualLogoutTime}, Status: ${s.status}, Hours: ${s.totalHours}`);
      } else {
        console.log(`${i+1}. Date: ${s.date}, Status: ${s.status} (No login/logout)`);
      }
    });

    mongoose.disconnect();
    console.log('Disconnected from MongoDB');

  } catch (error) {
    console.error('Error seeding sessions:', error);
    process.exit(1);
  }
}

// Run the seed function
seedSessions();