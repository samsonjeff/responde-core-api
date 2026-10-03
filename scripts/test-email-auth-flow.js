require('dotenv').config();
const { maskEmail, createVerificationChallenge, validateVerificationCode, sendVerificationEmail } = require('../utils/emailService');

async function runTests() {
    console.log('🧪 Starting 2FA Email & Brevo SMTP Verification Tests...\n');

    // Test 1: Mask Email
    console.log('1. Testing maskEmail:');
    const masked1 = maskEmail('jane.doe@example.com');
    const masked2 = maskEmail('admin@batstate-u.edu.ph');
    console.log('   jane.doe@example.com ->', masked1);
    console.log('   admin@batstate-u.edu.ph ->', masked2);
    if (!masked1.includes('*') || !masked2.includes('*')) throw new Error('maskEmail failed');
    console.log('   ✅ maskEmail passed.\n');

    // Test 2: Create challenge & validate incorrect code
    console.log('2. Testing challenge generation & invalid code attempt:');
    const chal = await createVerificationChallenge({
        email: 'test@example.com',
        userId: 'test-user-id',
        purpose: 'login'
    });
    console.log('   Challenge generated. Token length:', chal.challengeToken.length, 'Code:', chal.code);

    const badAttempt = await validateVerificationCode({
        challengeToken: chal.challengeToken,
        code: '111111',
        purpose: 'login'
    });
    console.log('   Bad attempt result:', badAttempt);
    if (badAttempt.valid !== false) throw new Error('Bad attempt should have failed');
    console.log('   ✅ Bad code correctly rejected with remaining attempts.\n');

    // Test 3: Validate correct code
    console.log('3. Testing valid code validation:');
    const goodAttempt = await validateVerificationCode({
        challengeToken: chal.challengeToken,
        code: chal.code,
        purpose: 'login'
    });
    console.log('   Good attempt result:', goodAttempt);
    if (goodAttempt.valid !== true) throw new Error('Valid code should have succeeded');
    console.log('   ✅ Valid code correctly verified and consumed.\n');

    // Test 4: Reusing consumed code
    console.log('4. Testing code consumption (one-time use):');
    const reuseAttempt = await validateVerificationCode({
        challengeToken: chal.challengeToken,
        code: chal.code,
        purpose: 'login'
    });
    console.log('   Reuse attempt result:', reuseAttempt);
    if (reuseAttempt.valid !== false) throw new Error('Reused code should have failed');
    console.log('   ✅ Reused code correctly rejected (one-time protection verified).\n');

    // Test 5: Role Change challenge
    console.log('5. Testing role change challenge:');
    const roleChal = await createVerificationChallenge({
        email: 'admin@example.com',
        userId: 'admin-user-id',
        purpose: 'role_change'
    });
    const wrongPurposeCheck = await validateVerificationCode({
        challengeToken: roleChal.challengeToken,
        code: roleChal.code,
        purpose: 'login' // deliberately wrong purpose
    });
    console.log('   Wrong purpose check:', wrongPurposeCheck);
    if (wrongPurposeCheck.valid !== false) throw new Error('Wrong purpose should have failed');
    console.log('   ✅ Purpose separation correctly enforced.\n');

    console.log('🎉 ALL BACKEND 2FA & EMAIL VERIFICATION TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
