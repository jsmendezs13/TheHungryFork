// taster.js — the shared taster account module for The Hungry Fork.
//
// index.html and menu.html each used to carry a byte-identical copy of this
// modal, its styles and its logic: ~460 duplicated lines per page. That is how
// the Cloudflare Turnstile widget ended up on index.html and not on menu.html,
// leaving the signup endpoint reachable from a page with no bot check at all.
// One copy, loaded by both pages, is the fix.
//
// Load it AFTER the page markup and BEFORE the page's own inline script:
//
//   <link rel="stylesheet" href="/taster.css">          (in <head>)
//   <script>window.TASTER = {successLabel:'…', onSuccess:function(){…}};</script>
//   <script src="/taster.js"></script>
//   <script> …the page's own code… </script>
//
// The page supplies only what actually differs between the two: the label and
// action of the button on the final success step.

// ── PAGE CONFIG ──
var TASTER = window.TASTER || {};
function tasterSuccessAction(){
  closeTasterModal();
  if(typeof TASTER.onSuccess==='function')TASTER.onSuccess();
}

// ── SHARED STATE ──
// var, not let: the page's inline script runs after this file and reads these.
var currentTaster=null, currentSession=null, pendingVerificationTicket=null;

// ── TOAST ──
// Was defined identically in both pages; it lives here now because the module
// below depends on it.
function showToast(msg){const t=document.getElementById('toast');if(!t)return;t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3500);}

// ── PHONE CONFIRMATION ──
//
// A Colombian mobile is ten digits starting with 3 — and so are plenty of US
// numbers. Typed without +57, "3193760213" parses as a perfectly valid US
// number in Iowa, so the code goes to a stranger, the real user never gets it,
// and we pay for the message. The server cannot tell the difference; only the
// person holding the phone can.
//
// So before spending an SMS we show the number the way the server will read it
// and ask. Deliberately permissive: when this cannot confidently normalize the
// input it returns null, no question is asked, and the server stays the
// authority on what is valid. Being stricter here than the API would block
// real users.
function tasterUsPreview(raw){
  const d=String(raw||'').replace(/\D/g,'');
  let ten=null;
  if(d.length===10)ten=d;
  else if(d.length===11&&d[0]==='1')ten=d.slice(1);
  if(!ten)return null;
  if(ten[0]<'2'||ten[3]<'2')return null; // area code and exchange can't start with 0 or 1
  return '+1 ('+ten.slice(0,3)+') '+ten.slice(3,6)+'-'+ten.slice(6);
}

var tasterAgreed={signup:false,reset:false};

// Returns true when the send may proceed.
function tasterPhoneAgreed(flow,phone,err){
  if(tasterAgreed[flow])return true;
  const preview=tasterUsPreview(phone);
  if(!preview)return true; // can't read it — let the server answer
  const box=document.getElementById(flow+'-confirm');
  const num=document.getElementById(flow+'-confirm-num');
  const btn=document.getElementById(flow+'-send-btn');
  if(!box||!num)return true;
  if(err)err.style.display='none';
  num.textContent=preview;
  box.hidden=false;
  if(btn)btn.hidden=true;
  return false;
}

function tasterConfirmPhone(flow){
  tasterAgreed[flow]=true;
  tasterHideConfirm(flow);
  if(flow==='signup')sendSignupOtp(); else sendResetOtp();
}

function tasterCancelPhone(flow){
  tasterAgreed[flow]=false;
  tasterHideConfirm(flow);
  document.getElementById(flow+'-phone')?.focus();
}

function tasterHideConfirm(flow){
  const box=document.getElementById(flow+'-confirm');
  const btn=document.getElementById(flow+'-send-btn');
  if(box)box.hidden=true;
  if(btn)btn.hidden=false;
}

// Editing the number withdraws the confirmation — otherwise someone could
// approve one number and send to another.
function tasterPhoneEdited(flow){
  tasterAgreed[flow]=false;
  tasterHideConfirm(flow);
}

// ── MODAL MARKUP ──
// Injected rather than duplicated in both pages. Appended to <body>; the modal
// is a fixed-position overlay, so its position in the document does not matter.
const TASTER_MODAL_HTML = `
<!-- TASTER AUTH MODAL -->
<div class="t-overlay" id="taster-modal">
  <div class="t-box">
    <div class="t-header">
      <h3>🍴 Hungry for Your Opinion</h3>
      <button class="t-close" onclick="closeTasterModal()">✕</button>
    </div>
    <div class="t-body">

      <!-- STEP 0: Choose login or signup -->
      <div class="t-step active" id="t-step-0">
        <div class="t-choice-header">
          <span class="t-choice-icon">🍽️</span>
          <div class="t-choice-title">Welcome, Taster!</div>
          <div class="t-choice-sub">Log in or create your free account to rate dishes and earn Fork's Lucky Bite!</div>
        </div>
        <div class="t-choice" style="margin-top:1.25rem;">
          <button class="t-btn" onclick="goTStep(1)">Log In</button>
          <button class="t-btn-ghost" onclick="goTStep(10)">New Taster? Join Us 🍴</button>
        </div>
      </div>

      <!-- STEP 1: LOGIN - phone + PIN -->
      <div class="t-step" id="t-step-1">
        <div class="t-label">Log In</div>
        <div class="t-sub">Enter your phone number and 6-digit PIN.</div>
        <input class="t-input" id="login-phone" type="tel" placeholder="+1 (555) 000-0000" autocomplete="tel">
        <input class="t-input" id="login-pin" type="password" placeholder="6-digit PIN" maxlength="6" inputmode="numeric">
        <div class="t-err" id="login-err">Invalid phone or PIN. Please try again.</div>
        <button class="t-btn" onclick="doLogin()">Log In</button>
        <div class="t-resend"><a onclick="goTStep(20)">Forgot your PIN?</a></div>
        <button class="t-btn-ghost" onclick="goTStep(0)">← Back</button>
      </div>

      <!-- STEP 20: RESET - phone -->
      <div class="t-step" id="t-step-20">
        <div class="t-label">Reset your PIN</div>
        <div class="t-sub">Enter your phone number and we'll send you a verification code.</div>
        <input class="t-input" id="reset-phone" type="tel" placeholder="+1 (555) 000-0000" autocomplete="tel" oninput="tasterPhoneEdited('reset')">
        <div class="t-hint">US numbers only — we can't text other countries yet.</div>
        <div class="t-err" id="reset-phone-err"></div>
        <div id="ts-reset" style="margin:0 0 .75rem;"></div>
        <button class="t-btn" id="reset-send-btn" onclick="sendResetOtp()">Send Code</button>
        <div class="t-confirm" id="reset-confirm" hidden>
          <div class="t-confirm-q">We'll text <span class="t-confirm-num" id="reset-confirm-num"></span>.<br>Is that the right number?</div>
          <button class="t-btn" onclick="tasterConfirmPhone('reset')">Yes, send the code</button>
          <button class="t-btn-ghost" onclick="tasterCancelPhone('reset')">No, let me fix it</button>
        </div>
        <button class="t-btn-ghost" onclick="goTStep(1)">← Back</button>
      </div>

      <!-- STEP 21: RESET - code -->
      <div class="t-step" id="t-step-21">
        <div class="t-label">Enter your code</div>
        <div class="t-sub" id="reset-sent-to">We sent a 4-digit code to your number.</div>
        <input class="t-input t-input-code" id="reset-otp" type="number" placeholder="0000" maxlength="4" autocomplete="one-time-code">
        <div class="t-err" id="reset-otp-err"></div>
        <button class="t-btn" onclick="verifyResetOtp()">Verify</button>
        <div class="t-resend">Didn't get it? <a onclick="goTStep(20)">Resend code</a></div>
      </div>

      <!-- STEP 22: RESET - new PIN -->
      <div class="t-step" id="t-step-22">
        <div class="t-label">Create a new PIN</div>
        <div class="t-sub">Choose a new 6-digit PIN. Keep it safe!</div>
        <input class="t-input" id="reset-pin" type="password" placeholder="New 6-digit PIN" maxlength="6" inputmode="numeric">
        <input class="t-input" id="reset-pin2" type="password" placeholder="Confirm new PIN" maxlength="6" inputmode="numeric">
        <div class="t-err" id="reset-pin-err"></div>
        <button class="t-btn" onclick="doResetPin()">Save New PIN</button>
      </div>

      <!-- STEP 10: SIGNUP - phone + OTP -->
      <div class="t-step" id="t-step-10">
        <div class="t-label">Step 1 of 3 — Verify your number</div>
        <div class="t-sub">We'll send a 4-digit code to confirm it's really you.</div>
        <input class="t-input" id="signup-phone" type="tel" placeholder="+1 (555) 000-0000" autocomplete="tel" oninput="tasterPhoneEdited('signup')">
        <div class="t-hint">US numbers only — we can't text other countries yet.</div>
        <div class="t-err" id="signup-phone-err">Please enter a valid phone number.</div>
        <div id="ts-signup" style="margin:0 0 .75rem;"></div>
        <button class="t-btn" id="signup-send-btn" onclick="sendSignupOtp()">Send Code</button>
        <div class="t-confirm" id="signup-confirm" hidden>
          <div class="t-confirm-q">We'll text <span class="t-confirm-num" id="signup-confirm-num"></span>.<br>Is that the right number?</div>
          <button class="t-btn" onclick="tasterConfirmPhone('signup')">Yes, send the code</button>
          <button class="t-btn-ghost" onclick="tasterCancelPhone('signup')">No, let me fix it</button>
        </div>
        <button class="t-btn-ghost" onclick="goTStep(0)">← Back</button>
      </div>

      <!-- STEP 11: SIGNUP - enter OTP -->
      <div class="t-step" id="t-step-11">
        <div class="t-label">Step 1 of 3 — Enter your code</div>
        <div class="t-sub" id="signup-sent-to">We sent a 4-digit code to your number.</div>
        <input class="t-input t-input-code" id="signup-otp" type="number" placeholder="0000" maxlength="4" autocomplete="one-time-code">
        <div class="t-err" id="signup-otp-err">Invalid code. Please try again.</div>
        <button class="t-btn" onclick="verifySignupOtp()">Verify</button>
        <div class="t-resend">Didn't get it? <a onclick="goTStep(10)">Resend code</a></div>
      </div>

      <!-- STEP 12: SIGNUP - personal info -->
      <div class="t-step" id="t-step-12">
        <div class="t-label">Step 2 of 3 — Your profile</div>
        <div class="t-sub">Tell us a little about yourself.</div>
        <input class="t-input" id="signup-first" type="text" placeholder="First name" autocomplete="given-name">
        <input class="t-input" id="signup-last" type="text" placeholder="Last name" autocomplete="family-name">
        <div style="margin-bottom:0.85rem;">
          <div style="font-size:0.75rem;color:var(--muted);font-family:'Inter',sans-serif;margin-bottom:0.4rem;">Date of birth</div>
          <div style="display:flex;gap:0.5rem;">
            <select class="t-select" id="signup-dob-month" style="margin-bottom:0;flex:2;">
              <option value="">Month</option>
              <option value="01">January</option>
              <option value="02">February</option>
              <option value="03">March</option>
              <option value="04">April</option>
              <option value="05">May</option>
              <option value="06">June</option>
              <option value="07">July</option>
              <option value="08">August</option>
              <option value="09">September</option>
              <option value="10">October</option>
              <option value="11">November</option>
              <option value="12">December</option>
            </select>
            <select class="t-select" id="signup-dob-day" style="margin-bottom:0;flex:1;">
              <option value="">Day</option>
              <option>1</option><option>2</option><option>3</option><option>4</option><option>5</option>
              <option>6</option><option>7</option><option>8</option><option>9</option><option>10</option>
              <option>11</option><option>12</option><option>13</option><option>14</option><option>15</option>
              <option>16</option><option>17</option><option>18</option><option>19</option><option>20</option>
              <option>21</option><option>22</option><option>23</option><option>24</option><option>25</option>
              <option>26</option><option>27</option><option>28</option><option>29</option><option>30</option>
              <option>31</option>
            </select>
            <select class="t-select" id="signup-dob-year" style="margin-bottom:0;flex:1.5;">
              <option value="">Year</option>
            </select>
          </div>
        </div>
        <select class="t-select" id="signup-gender">
          <option value="">Select gender</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
          <option value="non-binary">Non-binary</option>
          <option value="other">Other</option>
        </select>
        <div class="t-err" id="signup-info-err">Please fill in all fields.</div>
        <button class="t-btn" onclick="validateStep12()">Continue →</button>
      </div>

      <!-- STEP 13: SIGNUP - PIN + privacy -->
      <div class="t-step" id="t-step-13">
        <div class="t-label">Step 3 of 3 — Create your PIN</div>
        <div class="t-sub">Choose a 6-digit PIN to log in next time. Keep it safe!</div>
        <input class="t-input" id="signup-pin" type="password" placeholder="6-digit PIN" maxlength="6" inputmode="numeric">
        <input class="t-input" id="signup-pin2" type="password" placeholder="Confirm PIN" maxlength="6" inputmode="numeric">
        <div class="t-checkbox-row">
          <input type="checkbox" id="signup-privacy">
          <label for="signup-privacy">I agree to the <a href="#" style="color:var(--red);">Privacy Policy</a> and <a href="#" style="color:var(--red);">Terms of Service</a>.</label>
        </div>
        <div class="t-checkbox-row">
          <input type="checkbox" id="signup-promos">
          <label for="signup-promos">I'd like to receive promotions and special offers.</label>
        </div>
        <div class="t-err" id="signup-pin-err">Please check your PIN and accept the privacy policy.</div>
        <button class="t-btn" onclick="doSignup()">Create My Account 🍴</button>
        <button class="t-btn-ghost" onclick="goTStep(12)">← Back</button>
      </div>

      <!-- STEP 99: SUCCESS -->
      <div class="t-step" id="t-step-99">
        <div style="text-align:center; padding:1rem 0;">
          <div style="font-size:3rem; margin-bottom:1rem;">🎉</div>
          <div style="font-family:'Cormorant Garamond',serif; font-size:1.2rem; font-weight:700; color:var(--red); margin-bottom:0.5rem;" id="t-welcome-msg">Welcome!</div>
          <div style="font-family:'Inter',sans-serif; font-size:0.9rem; color:var(--muted); margin-bottom:1.5rem;">You're now logged in. Let's rate some dishes!</div>
          <button class="t-btn" id="t-success-btn" onclick="tasterSuccessAction()">Continue</button>
        </div>
      </div>

    </div>
  </div>
</div>

`;

(function mountTasterModal(){
  const host=document.createElement('div');
  host.innerHTML=TASTER_MODAL_HTML;
  while(host.firstChild)document.body.appendChild(host.firstChild);
  const sb=document.getElementById('t-success-btn');
  if(sb&&TASTER.successLabel)sb.textContent=TASTER.successLabel;
})();

// ── SESSION ──
function saveSession(t,s){localStorage.setItem('hf_taster',JSON.stringify({taster:t,session:s}));currentTaster=t;currentSession=s;updateNavBtn();}
function loadSession(){
  try{
    const raw=localStorage.getItem('hf_taster');
    if(raw){
      const parsed=JSON.parse(raw);
      if(parsed&&parsed.taster){currentTaster=parsed.taster;currentSession=parsed.session||null;}
      else{currentTaster=parsed;currentSession=null;}
      updateNavBtn();
    }
  }catch(e){}
}
function logout(){localStorage.removeItem('hf_taster');currentTaster=null;currentSession=null;updateNavBtn();showToast('Logged out. See you next time!');}
function updateNavBtn(){
  const btn=document.getElementById('nav-taster-btn');
  const tastingsBtn=document.getElementById('nav-tastings-btn');
  if(!btn)return;
  if(currentTaster){
    btn.textContent=currentTaster.first_name;
    btn.onclick=()=>{if(confirm('Log out?'))logout();};
    if(tastingsBtn)tastingsBtn.style.display='inline-block';
  }else{
    btn.textContent='Log In';
    btn.onclick=openTasterModal;
    if(tastingsBtn)tastingsBtn.style.display='none';
  }
}

// ── TASTER MODAL ──
function openTasterModal(){document.getElementById('taster-modal').classList.add('open');goTStep(currentTaster?99:0);}
function closeTasterModal(){document.getElementById('taster-modal').classList.remove('open');}
function goTStep(n){document.querySelectorAll('.t-step').forEach(s=>s.classList.remove('active'));document.getElementById('t-step-'+n)?.classList.add('active');if(n===10)tsMount('signup','ts-signup');if(n===20)tsMount('reset','ts-reset');}

// ── POPULATE YEAR DROPDOWN ──
(function(){
  const sel=document.getElementById('signup-dob-year');
  if(!sel)return;
  const yr=new Date().getFullYear();
  for(let y=yr-10;y>=1920;y--){const o=document.createElement('option');o.value=y;o.textContent=y;sel.appendChild(o);}
})();

// ── VALIDATE STEP 12 ──
function validateStep12(){
  const first=document.getElementById('signup-first').value.trim();
  const last=document.getElementById('signup-last').value.trim();
  const month=document.getElementById('signup-dob-month').value;
  const day=document.getElementById('signup-dob-day').value;
  const year=document.getElementById('signup-dob-year').value;
  const gender=document.getElementById('signup-gender').value;
  const err=document.getElementById('signup-info-err');
  if(!first){err.textContent='Please enter your first name.';err.style.display='block';return;}
  if(!last){err.textContent='Please enter your last name.';err.style.display='block';return;}
  if(!month||!day||!year){err.textContent='Please select your complete date of birth.';err.style.display='block';return;}
  if(!gender){err.textContent='Please select your gender.';err.style.display='block';return;}
  err.style.display='none';
  goTStep(13);
}

// ── FORMAT PHONE ──
function formatPhone(phone){
  phone=phone.replace(/\D/g,'');
  if(phone.length===10)return'+1'+phone;
  if(phone.length===11&&phone.startsWith('1'))return'+'+phone;
  if(!phone.startsWith('+'))return'+'+phone;
  return phone;
}

// ── LOGIN ──
async function doLogin(){
  const phone=formatPhone(document.getElementById('login-phone').value.trim());
  const pin=document.getElementById('login-pin').value.trim();
  const err=document.getElementById('login-err');
  err.style.display='none';
  if(!phone||!pin){err.textContent='Please enter your phone and PIN.';err.style.display='block';return;}
  const btn=document.querySelector('#t-step-1 .t-btn');
  btn.disabled=true;btn.textContent='Logging in…';
  try{
    const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,pin})});
    const d=await res.json();
    if(res.ok&&d.success){
      saveSession(d.taster,d.session);
      document.getElementById('t-welcome-msg').textContent='Welcome back, '+d.taster.first_name+'!';
      goTStep(99);
    }else{
      err.textContent=d.error||'Invalid phone or PIN. Please try again.';
      err.style.display='block';
    }
  }catch(e){err.textContent='Connection error. Please try again.';err.style.display='block';}
  btn.disabled=false;btn.textContent='Log In';
}

// ── TURNSTILE ──
// The widgets live inside .t-step containers, which are display:none until
// their step is active. Turnstile cannot run a challenge inside a hidden
// element, so each widget is rendered explicitly the first time its step is
// shown, and reset every time it is shown again — a token is single-use and
// expires after about five minutes, so a second send always needs a fresh one.
const TURNSTILE_SITEKEY='0x4AAAAAAElNixquFc4Pc3RM';
const tsWidgets={};
const tsTokens={signup:null,reset:null};
function tsMount(flow,containerId){
  if(typeof turnstile==='undefined'||!turnstile.render){setTimeout(()=>tsMount(flow,containerId),200);return;}
  if(tsWidgets[flow]!==undefined){tsRefresh(flow);return;}
  tsTokens[flow]=null;
  tsWidgets[flow]=turnstile.render('#'+containerId,{
    sitekey:TURNSTILE_SITEKEY,
    theme:'light',
    callback:function(t){tsTokens[flow]=t;},
    'expired-callback':function(){tsTokens[flow]=null;},
    'error-callback':function(){tsTokens[flow]=null;}
  });
}
// Called after every send attempt: the server consumes the token whether the
// send succeeded or not, so the widget must hand out a new one.
function tsRefresh(flow){
  tsTokens[flow]=null;
  if(tsWidgets[flow]!==undefined&&typeof turnstile!=='undefined'){turnstile.reset(tsWidgets[flow]);}
}

// ── FORGOT PIN ──
let pendingResetTicket=null;
async function sendResetOtp(){
  const phone=document.getElementById('reset-phone').value.trim();
  const err=document.getElementById('reset-phone-err');
  err.style.display='none';
  if(!phone){err.textContent='Please enter your phone number.';err.style.display='block';return;}
  if(!tsTokens.reset){err.textContent='Please complete the verification check above.';err.style.display='block';return;}
  if(!tasterPhoneAgreed('reset',phone,err))return;
  const btn=document.getElementById('reset-send-btn');
  btn.disabled=true;btn.textContent='Sending…';
  try{
    const res=await fetch('/api/send-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,purpose:'reset',turnstileToken:tsTokens.reset})});
    const d=await res.json();
    if(d.success){document.getElementById('reset-sent-to').textContent='We sent a 4-digit code to '+phone+'.';goTStep(21);}
    else{err.textContent=d.error||'Could not send code.';err.style.display='block';}
  }catch(e){err.textContent='Network error. Please try again.';err.style.display='block';}
  tsRefresh('reset');
  btn.disabled=false;btn.textContent='Send Code';
}
async function verifyResetOtp(){
  const phone=document.getElementById('reset-phone').value.trim();
  const code=document.getElementById('reset-otp').value.trim();
  const err=document.getElementById('reset-otp-err');
  err.style.display='none';
  if(code.length!==4){err.textContent='Enter the 4-digit code.';err.style.display='block';return;}
  const btn=document.querySelector('#t-step-21 .t-btn');
  btn.disabled=true;btn.textContent='Verifying…';
  try{
    const res=await fetch('/api/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,code,purpose:'reset'})});
    const d=await res.json();
    if(d.success){pendingResetTicket=d.verificationTicket;goTStep(22);}
    else{err.textContent=d.error||'Invalid code.';err.style.display='block';}
  }catch(e){err.textContent='Network error.';err.style.display='block';}
  btn.disabled=false;btn.textContent='Verify';
}
async function doResetPin(){
  const pin=document.getElementById('reset-pin').value.trim();
  const pin2=document.getElementById('reset-pin2').value.trim();
  const err=document.getElementById('reset-pin-err');
  err.style.display='none';
  if(pin.length!==6||pin!==pin2){err.textContent='PINs must be 6 digits and match.';err.style.display='block';return;}
  if(!pendingResetTicket){err.textContent='Verification expired. Please verify your phone again.';err.style.display='block';return;}
  const phone=formatPhone(document.getElementById('reset-phone').value.trim());
  const btn=document.querySelector('#t-step-22 .t-btn');
  btn.disabled=true;btn.textContent='Saving…';
  try{
    const res=await fetch('/api/reset-pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({verificationTicket:pendingResetTicket,phone_number:phone,pin})});
    const d=await res.json();
    if(res.ok&&d.success){
      pendingResetTicket=null;
      saveSession(d.taster,d.session);
      document.getElementById('t-welcome-msg').textContent='Welcome back, '+d.taster.first_name+'!';
      goTStep(99);
    }else{err.textContent=d.error||'Could not reset PIN.';err.style.display='block';}
  }catch(e){err.textContent='Network error. Please try again.';err.style.display='block';}
  btn.disabled=false;btn.textContent='Save New PIN';
}

// ── SIGNUP OTP ──
async function sendSignupOtp(){
  const phone=document.getElementById('signup-phone').value.trim();
  const err=document.getElementById('signup-phone-err');
  err.style.display='none';
  if(!phone){err.textContent='Please enter a phone number.';err.style.display='block';return;}
  if(!tsTokens.signup){err.textContent='Please complete the verification check above.';err.style.display='block';return;}
  if(!tasterPhoneAgreed('signup',phone,err))return;
  const btn=document.getElementById('signup-send-btn');
  btn.disabled=true;btn.textContent='Sending…';
  try{
    const res=await fetch('/api/send-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,turnstileToken:tsTokens.signup})});
    const d=await res.json();
    if(d.success){document.getElementById('signup-sent-to').textContent='We sent a 4-digit code to '+phone+'.';goTStep(11);}
    else if(d.code==='ALREADY_REGISTERED'){
      err.innerHTML='This phone number already has an account. <a onclick="document.getElementById(\'login-phone\').value=\''+phone+'\';goTStep(1);" style="text-decoration:underline;cursor:pointer;">Log in instead</a>';
      err.style.display='block';
    }
    else{err.textContent=d.error||'Could not send code. Check the number.';err.style.display='block';}
  }catch(e){err.textContent='Network error. Please try again.';err.style.display='block';}
  tsRefresh('signup');
  btn.disabled=false;btn.textContent='Send Code';
}
async function verifySignupOtp(){
  const phone=document.getElementById('signup-phone').value.trim();
  const code=document.getElementById('signup-otp').value.trim();
  const err=document.getElementById('signup-otp-err');
  err.style.display='none';
  if(code.length!==4){err.textContent='Enter the 4-digit code.';err.style.display='block';return;}
  const btn=document.querySelector('#t-step-11 .t-btn');
  btn.disabled=true;btn.textContent='Verifying…';
  try{
    const res=await fetch('/api/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,code})});
    const d=await res.json();
    if(d.success){pendingVerificationTicket=d.verificationTicket;goTStep(12);}
    else{err.textContent=d.error||'Invalid code.';err.style.display='block';}
  }catch(e){err.textContent='Network error.';err.style.display='block';}
  btn.disabled=false;btn.textContent='Verify';
}

// ── SIGNUP ACCOUNT ──
async function doSignup(){
  const first=document.getElementById('signup-first').value.trim();
  const last=document.getElementById('signup-last').value.trim();
  const month=document.getElementById('signup-dob-month').value;
  const day=document.getElementById('signup-dob-day').value.padStart(2,'0');
  const year=document.getElementById('signup-dob-year').value;
  const dob=year+'-'+month+'-'+day;
  const gender=document.getElementById('signup-gender').value;
  const pin=document.getElementById('signup-pin').value.trim();
  const pin2=document.getElementById('signup-pin2').value.trim();
  const privacy=document.getElementById('signup-privacy').checked;
  const promos=document.getElementById('signup-promos').checked;
  const err=document.getElementById('signup-pin-err');
  err.style.display='none';
  if(!first||!last||!dob||!gender){err.textContent='Please fill in all profile fields (step 2).';err.style.display='block';return;}
  if(pin.length!==6||pin!==pin2){err.textContent='PINs must be 6 digits and match.';err.style.display='block';return;}
  if(!privacy){err.textContent='Please accept the Privacy Policy to continue.';err.style.display='block';return;}
  if(!pendingVerificationTicket){err.textContent='Verification expired. Please verify your phone again.';err.style.display='block';return;}
  const phone=formatPhone(document.getElementById('signup-phone').value.trim());
  const btn=document.querySelector('#t-step-13 .t-btn');
  btn.disabled=true;btn.textContent='Creating account…';
  try{
    const res=await fetch('/api/complete-signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      verificationTicket:pendingVerificationTicket,
      first_name:first,last_name:last,date_of_birth:dob,gender,phone_number:phone,pin,
      privacy_accepted:true,promotions_accepted:promos
    })});
    const d=await res.json();
    if(res.ok&&d.success){
      pendingVerificationTicket=null;
      saveSession(d.taster,d.session);
      document.getElementById('t-welcome-msg').textContent='Welcome, '+first+'! 🍴';
      goTStep(99);
    }else{
      err.textContent=d.error||'Could not create account. Please try again.';
      err.style.display='block';
    }
  }catch(e){err.textContent='Network error. Please try again.';err.style.display='block';}
  btn.disabled=false;btn.textContent='Create My Account 🍴';
}
