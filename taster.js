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
          <label for="signup-privacy">I agree to the <a href="/privacy" target="_blank" rel="noopener" style="color:var(--red);">Privacy Policy</a> and <a href="/terms" target="_blank" rel="noopener" style="color:var(--red);">Terms of Service</a>.</label>
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
  hfPinBoxes();
})();

// ── PIN BOXES: the number keypad only (Sebastian, 7 Oct) ──
// A PIN is six digits, but iPhones show the full letter keyboard for any
// password box, whatever inputmode says, and a letter then fails with an
// error. So on iPhones and iPads (and only there), where the browser can draw
// dots in a plain text box, the five PIN boxes become text boxes that ask for
// the number keypad and show dots. Everywhere else they stay password boxes:
// Android already shows the number keypad for those, and a password box is
// what screen readers and password managers treat as secret (review, 8 Oct).
// Either way anything that is not a digit is dropped as it is typed or
// pasted, and only six digits are kept.
function hfPinBoxes(){
  var ua=navigator.userAgent||'';
  var ios=/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1);   // iPads say "Macintosh"
  var dots=ios&&!!(window.CSS&&CSS.supports&&CSS.supports('-webkit-text-security','disc'));
  ['login-pin','reset-pin','reset-pin2','signup-pin','signup-pin2'].forEach(function(id){
    var box=document.getElementById(id);
    if(!box)return;
    box.setAttribute('inputmode','numeric');
    box.setAttribute('pattern','[0-9]*');
    // The login box may be filled from a saved PIN. The new-PIN boxes are not
    // marked "new-password": that is what makes browsers offer a long strong
    // password, which a six-digit box cannot take (review, 8 Oct). If Safari
    // suggests one anyway, passwordrules keeps it to six digits.
    if(id==='login-pin')box.setAttribute('autocomplete','current-password');
    else box.setAttribute('passwordrules','minlength: 6; maxlength: 6; required: digit; allowed: digit;');
    box.removeAttribute('maxlength');           // so a pasted "12 34 56" still fits
    if(dots){
      box.type='text';
      box.style.setProperty('-webkit-text-security','disc');
      box.setAttribute('autocorrect','off');
      box.setAttribute('autocapitalize','off');
      box.spellcheck=false;
    }
    box.addEventListener('input',function(){
      var d=box.value.replace(/\D/g,'').slice(0,6);
      if(box.value!==d)box.value=d;
    });
  });
}

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
function logout(){localStorage.removeItem('hf_taster');try{sessionStorage.removeItem('hf_inbox');}catch(e){}if(typeof HF_INBOX!=='undefined'){HF_INBOX.data=null;HF_INBOX.problem=null;HF_INBOX.who=undefined;}currentTaster=null;currentSession=null;updateNavBtn();showToast('Logged out. See you next time!');}

// ── CORNER ACCOUNT MENU ──
//
// The account links used to be two buttons in each page footer, plus a third
// copy rebuilt by hand inside menu.html's cave view. Three copies of the same
// three links, and the cave one had to be re-rendered on every login state
// change or it went stale. One fixed control in the top-right corner replaces
// all of them: it is injected here, it re-renders itself from currentTaster,
// and it is the only place that decides what a signed-in taster may see.
//
// Since 8 Oct the corner is a row of round buttons (Sebastian's picture 12):
//   [bell] [role] [☰]
// the bell for anyone logged in (the restaurant answered you), the role icon
// for staff (key = owner, clipboard = manager, chef hat = crew, his eagle for
// the platform admin; it goes to the manager page and carries the count of
// guest messages waiting), and the ☰, which is now personal only.
var HF_CORNER_HTML =
  '<div class="hf-corner" id="hf-corner">'
+   '<div class="hf-corner-bar">'
+     '<button class="hf-bell" id="hf-bell" type="button" aria-label="Notifications" aria-expanded="false" aria-controls="hf-bell-panel" hidden>'
+       '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
+         '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.6 2.1H4.4z"/><path d="M9.8 20.6a2.4 2.4 0 0 0 4.4 0"/></svg>'
+       '<b class="hf-count" hidden></b>'
+     '</button>'
+     '<a class="hf-role" id="hf-role" href="/manager" hidden><b class="hf-count" hidden></b></a>'
+     '<button class="hf-corner-toggle" id="hf-corner-toggle" type="button" aria-label="Account menu" aria-expanded="false" aria-controls="hf-corner-items">'
+       '<span></span><span></span><span></span><i class="hf-corner-dot"></i>'
+     '</button>'
+   '</div>'
+   '<div class="hf-bell-panel" id="hf-bell-panel" role="region" aria-label="Notifications" hidden></div>'
+   '<div class="hf-corner-items" id="hf-corner-items"></div>'
+ '</div>';

// first_name is whatever the taster typed at signup, so it never goes into
// innerHTML raw.
function hfEsc(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function openCornerMenu(){
  const root=document.getElementById('hf-corner');
  if(!root)return;
  hfBellClose();
  root.classList.add('open');
  const t=document.getElementById('hf-corner-toggle');
  if(t)t.setAttribute('aria-expanded','true');
}
function closeCornerMenu(){
  const root=document.getElementById('hf-corner');
  if(!root)return;
  root.classList.remove('open');
  const t=document.getElementById('hf-corner-toggle');
  if(t)t.setAttribute('aria-expanded','false');
}
function toggleCornerMenu(){
  const root=document.getElementById('hf-corner');
  if(!root)return;
  if(root.classList.contains('open'))closeCornerMenu();else openCornerMenu();
}

// Kept under its old name because saveSession, loadSession and logout all call
// it, on both pages.
function updateNavBtn(){
  const root=document.getElementById('hf-corner');
  const list=document.getElementById('hf-corner-items');
  if(!list)return;

  const items=[];
  if(currentTaster){
    items.push({label:'Hi, '+(currentTaster.first_name||'there'), kind:'label', cls:'hf-corner-name'});
    // Sebastian's order (7 Oct): My Reservations first, then My Tastings,
    // then My Visits, then Log Out. My Reservations goes straight to the
    // booking page's own list rather than a fourth overlay copied onto every
    // page.
    items.push({label:'My Reservations', href:'/reservations#mine'});
    items.push({label:'My Tastings', act:'tastings'});
    items.push({label:'My Visits', act:'visits'});
    // The manager page is not in here any more (Sebastian, 8 Oct): this menu is
    // the person's own, and the restaurant's door is the role icon beside it.
    items.push({label:'Log Out', act:'logout'});
  }else{
    items.push({label:'Log In', act:'login'});
  }

  list.innerHTML=items.map(function(it,i){
    const style=' style="--d:'+(i*45)+'ms"';
    const cls='hf-corner-item'+(it.cls?' '+it.cls:'');
    const text=hfEsc(it.label);
    if(it.kind==='label')return '<div class="'+cls+'"'+style+'>'+text+'</div>';
    if(it.href)return '<a class="'+cls+'" href="'+it.href+'"'+style+'>'+text+'</a>';
    return '<button type="button" class="'+cls+'" data-act="'+it.act+'"'+style+'>'+text+'</button>';
  }).join('');

  if(root)root.classList.toggle('signed-in',!!currentTaster);
  hfPaintHeader();
}

// ── THE BELL AND THE ROLE ICON (Sebastian, 8 Oct) ──
// Two flags decide whether the role icon is drawn at all: is_platform_admin is
// Sebastian, above every restaurant, and is_restaurant_admin marks an account
// that holds a role somewhere (the roles API keeps it in step), so ordinary
// customers never pay for a request to find out they are not managers. Neither
// is a permission: manager.html asks the server what the account may do.
function hfPaintHeader(){
  var bell=document.getElementById('hf-bell'), roleBtn=document.getElementById('hf-role');
  if(!bell||!roleBtn)return;
  var staff=!!(currentTaster&&(currentTaster.is_platform_admin||currentTaster.is_restaurant_admin));
  bell.hidden=!currentTaster;
  roleBtn.hidden=!staff;
  if(staff){
    var role=hfStaffRole()||'manager';            // the clipboard until the server says which
    if(roleBtn.getAttribute('data-role')!==role){
      roleBtn.setAttribute('data-role',role);
      var n=roleBtn.querySelector('.hf-count');
      roleBtn.innerHTML=hfRoleIcon(role);
      if(n)roleBtn.appendChild(n);
    }
  }else roleBtn.removeAttribute('data-role');
  // The page titles make room (taster.css): staff have three buttons.
  document.body.classList.toggle('hf-has-bell',!!currentTaster);
  document.body.classList.toggle('hf-has-role',staff);
  if(!currentTaster){hfBellClose();hfInboxPaint(null);return;}
  hfInboxPaint(HF_INBOX.who===hfWho()?HF_INBOX.data:null);
  hfInbox(false);
}
function hfWho(){return currentTaster?(currentTaster.id==null?null:currentTaster.id):undefined;}

// ── THE STAFF PILL: one icon per role (Sebastian, 8 Oct) ──
// The key for an owner, the clipboard for a manager, the chef hat for the
// crew, and the eagle for Sebastian (the platform admin). The browser only
// knows that an account holds some role somewhere; which one comes from
// /api/my-access, asked once per page and kept for ten minutes in this tab.
// Until it answers, the pill says "Manager", as it did before. This only
// draws a picture: manager.html asks the server what the account may do.
function hfRoleWord(role){
  return ({platform:'Admin', owner:'Owner', manager:'Manager', crew:'Crew'})[role]||'Manager';
}
function hfRoleIcon(role){
  var st=' width="22" height="22" aria-hidden="true" focusable="false"';
  var line=' fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  if(role==='platform')return hfEagle(27);
  var p={
    owner:'<circle cx="8" cy="15.5" r="4.2"/><path d="M11 12.5 20 3.5M16.5 7l2.5 2.5M14.2 9.3l2 2"/>',
    manager:'<rect x="5.5" y="4.5" width="13" height="16.5" rx="2"/><rect x="9" y="2.5" width="6" height="4" rx="1.2"/><path d="M9 13.2l2.2 2.2 4-4.4"/>',
    crew:'<path d="M7.5 17.5v-4a4 4 0 0 1-.8-7.6A4.5 4.5 0 0 1 12 3.2a4.5 4.5 0 0 1 5.3 2.7 4 4 0 0 1-.8 7.6v4z"/><path d="M7.5 20.5h9"/><path d="M10 13.8v3.7M14 13.8v3.7"/>'
  };
  return p[role]?'<svg viewBox="0 0 24 24"'+st+line+'>'+p[role]+'</svg>':'';
}
// Sebastian's eagle (8 Oct): a solid head facing right, drawn for him after
// the picture he sent — an original drawing, nobody's icon. The eye, the brow
// and the beak are cut out of the head with a mask, so it is one colour
// (currentColor) on any background. Each copy needs its own mask id.
function hfEagle(size){
  hfEagle.n=(hfEagle.n||0)+1;
  var id='hf-eagle-m'+hfEagle.n;
  var head='M40 26C50 24 62 23.5 80 24C92 25 101 29 105 36L104 39'
    +'C115 38 124 42 129 49C132 54 133 62 128 70C126 66 124 61 120 59.5C116 58.5 111 59 108 60L116 61.6L113 62.8L101 62.6'
    +'C96 66 93 72 93 80C93 92 100 102 106 110L111 117L103 116C103 122 101 127 99 131L86 123L64 117.5L40 116.8L29 116.5'
    +'Q18 118 9 116Q15 112 19 108C21 104 23 99 23 92Q13 90 8 82Q15 83 21 81C19 76 19 69 20 62Q12 60 8 52Q14 52 21 51'
    +'C22 46 25 41 31 37Q24 34 17 29Q28 26 40 26Z';
  var cut='<path d="M65.5 37.6C74 37 84 38 91.5 40.6" stroke="#000" stroke-width="2.6" stroke-linecap="round" fill="none"/>'
    +'<path d="M74 40.5C78.5 39.4 86 39.6 90.5 41.6C89.6 46.4 85.6 49.4 81.4 49.2C77.4 48.6 75 45 74 40.5Z" fill="#000"/>'
    +'<circle cx="82.6" cy="43.6" r="3.4" fill="#fff"/>'
    +'<path d="M89 42.2L102 41.8M102.2 42L102.2 50.5" stroke="#000" stroke-width="1.8" stroke-linecap="round" fill="none"/>'
    +'<path d="M103.4 49.2L103.4 52C96 54 88.4 56.6 80 57.8C87.4 55.2 95.4 51.6 103.4 49.2Z" fill="#000"/>'
    +'<path d="M80 58C90 57.6 100 57.5 109 58" stroke="#000" stroke-width="1.3" stroke-linecap="round" fill="none"/>'
    +'<circle cx="112.6" cy="44.2" r="1.4" fill="#000"/>';
  return '<svg class="hf-eagle" viewBox="6 13 128 128" width="'+size+'" height="'+size+'" aria-hidden="true" focusable="false">'
    +'<defs><mask id="'+id+'" maskUnits="userSpaceOnUse" x="0" y="0" width="160" height="160">'
    +'<rect x="0" y="0" width="160" height="160" fill="#fff"/>'+cut+'</mask></defs>'
    +'<path fill="currentColor" mask="url(#'+id+')" d="'+head+'"/></svg>';
}

// 'platform', 'owner', 'manager', 'crew', or '' while it is not known yet.
function hfStaffRole(){
  if(!currentTaster)return '';
  if(currentTaster.is_platform_admin)return 'platform';
  if(!currentTaster.is_restaurant_admin)return '';
  var who=currentTaster.id==null?null:currentTaster.id;
  try{
    var c=JSON.parse(sessionStorage.getItem('hf_role')||'null');
    if(c&&c.id===who&&Date.now()-c.at<600000)return c.role||'';
  }catch(e){}
  hfLoadRole(who);
  return '';
}
function hfLoadRole(who){
  if(hfLoadRole.asked==='#'+who||!currentSession)return;      // once per page for each account
  hfLoadRole.asked='#'+who;
  fetch('/api/my-access',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+currentSession},body:'{}'})
    .then(function(res){return res.ok?res.json():null;})
    .then(function(d){
      if(!d||!Array.isArray(d.restaurants))return;
      var rank={crew:1, manager:2, owner:3, platform:4}, best='';
      d.restaurants.forEach(function(x){ if(rank[x.role]&&(!best||rank[x.role]>rank[best]))best=x.role; });
      try{sessionStorage.setItem('hf_role',JSON.stringify({id:who, role:best, at:Date.now()}));}catch(e){}
      // Redraw only for the same account that asked (a logout in between: nothing).
      if(best&&currentTaster&&(currentTaster.id==null?null:currentTaster.id)===who)updateNavBtn();
    })
    .catch(function(){});
}

// ── WHAT IS NEW: the bell's list and the role icon's count ──
// One small question to the server (action "inbox"), kept for 10 seconds in
// this tab so that walking from page to page does not ask again each time,
// and asked again every 15 seconds while the page is on screen, and at once
// when the page comes back on screen (r22: was every minute, kept 45 seconds;
// Sebastian, 8 Oct: "the messages are slow to arrive"). A page that has just
// shown the guest a conversation calls hfInboxSeen() so the bell clears. A
// page that wants to hear what is new defines window.hfOnInbox(data).
var HF_INBOX={data:null, at:0, tried:0, who:undefined, busy:false, again:false, timer:null, problem:null, keep:10000, every:15000};

// ── HOW OFTEN TO ASK (r22) ──
// Pages ask the server for news every few seconds while someone is using them.
// A page left open with nobody touching it slows down: after 2 minutes to
// every 10 seconds, after 10 to every 30, and after half an hour it stops
// asking (staff pages keep asking once a minute: a tablet at the host stand is
// read, not touched). A touch, a key, or coming back to the page wakes it at
// once. Every question also costs the rate-limit counter (Upstash) a few
// commands, so a forgotten tab must not ask all day.
var HF_SEEN_AT=Date.now();
function hfActive(){var was=Date.now()-HF_SEEN_AT;HF_SEEN_AT=Date.now();return was;}
function hfPace(fast,slowest){
  var idle=Date.now()-HF_SEEN_AT;
  if(idle<120000)return fast;
  if(idle<600000)return Math.max(fast,10000);
  if(idle<1800000)return Math.max(fast,30000);
  return slowest;
}
function hfStaffish(){return !!(currentTaster&&(currentTaster.is_platform_admin||currentTaster.is_restaurant_admin));}
function hfInbox(force){
  var who=hfWho();
  if(!currentSession||who===undefined)return;
  if(!force){
    if(HF_INBOX.who===who&&HF_INBOX.data&&Date.now()-HF_INBOX.at<HF_INBOX.keep)return;
    try{
      var c=JSON.parse(sessionStorage.getItem('hf_inbox')||'null');
      if(c&&c.id===who&&Date.now()-c.at<HF_INBOX.keep&&c.data){HF_INBOX.data=c.data;HF_INBOX.at=c.at;HF_INBOX.who=who;hfInboxPaint(c.data);return;}
    }catch(e){}
  }
  // A question is already on its way: a forced one (something was just read)
  // is asked again as soon as it comes back, and that older answer is not drawn.
  if(HF_INBOX.busy){if(force)HF_INBOX.again=true;return;}
  HF_INBOX.busy=true;HF_INBOX.tried=Date.now();
  var token=currentSession;
  var staff=!!(currentTaster&&(currentTaster.is_platform_admin||currentTaster.is_restaurant_admin));
  fetch('/api/reservations',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
        body:JSON.stringify({action:'inbox',staff:staff})})
    .then(function(res){
      // A session that has ended (they last for 30 days) says so in the bell
      // instead of "Looking…" for ever.
      if(res.status===401){HF_INBOX.problem='expired';return null;}
      if(!res.ok){HF_INBOX.problem='down';return null;}
      return res.json();
    })
    .then(function(d){
      if(!d){var pn=document.getElementById('hf-bell-panel');if(pn&&!pn.hidden&&currentSession===token)hfBellRender();return;}
      // Only for the account that asked: a log-out or another log-in meanwhile draws nothing.
      if(!Array.isArray(d.bell)||currentSession!==token||hfWho()!==who||HF_INBOX.again)return;
      HF_INBOX.problem=null;
      var data={bell:d.bell, staff:d.staff||null};
      HF_INBOX.data=data;HF_INBOX.at=Date.now();HF_INBOX.who=who;
      try{sessionStorage.setItem('hf_inbox',JSON.stringify({id:who, at:HF_INBOX.at, data:data}));}catch(e){}
      hfInboxPaint(data);
    })
    .catch(function(){HF_INBOX.problem='down';var pn=document.getElementById('hf-bell-panel');if(pn&&!pn.hidden)hfBellRender();})
    .then(function(){HF_INBOX.busy=false;if(HF_INBOX.again){HF_INBOX.again=false;hfInbox(true);}});
}
function hfInboxSeen(){
  try{sessionStorage.removeItem('hf_inbox');}catch(e){}
  HF_INBOX.at=0;
  hfInbox(true);
}
function hfCount(el,n){
  var b=el&&el.querySelector('.hf-count');
  if(!b)return;
  b.hidden=!n;
  b.textContent=n>99?'99+':String(n||'');
}
function hfInboxPaint(data){
  var bell=document.getElementById('hf-bell'), roleBtn=document.getElementById('hf-role');
  var answers=data&&Array.isArray(data.bell)?data.bell.reduce(function(n,b){return n+(Number(b.count)||0);},0):0;
  var waiting=data&&data.staff?Number(data.staff.unread)||0:0;
  if(bell){
    hfCount(bell,answers);
    bell.setAttribute('aria-label',answers?'Notifications: '+answers+' new':'Notifications');
  }
  if(roleBtn){
    hfCount(roleBtn,waiting);
    var role=roleBtn.getAttribute('data-role')||'';
    // Guest messages waiting: the icon opens the manager page on them.
    roleBtn.setAttribute('href',waiting?'/manager#messages':'/manager');
    roleBtn.setAttribute('aria-label','Manager page ('+hfRoleWord(role)+')'+(waiting?', '+waiting+' new guest message'+(waiting===1?'':'s'):''));
  }
  var panel=document.getElementById('hf-bell-panel');
  if(panel&&!panel.hidden)hfBellRender();
  if(data&&typeof window.hfOnInbox==='function'){try{window.hfOnInbox(data);}catch(e){}}
}

// The bell's list: "Ana · The Hungry Fork answered you", the table, when.
// Each one opens that conversation in My Reservations.
function hfBellRender(){
  var panel=document.getElementById('hf-bell-panel');
  if(!panel)return;
  var list=HF_INBOX.who===hfWho()&&HF_INBOX.data?HF_INBOX.data.bell:null;
  if(!list){
    panel.innerHTML='<div class="hf-bell-head">Notifications</div><div class="hf-bell-empty">'
      +(HF_INBOX.problem==='expired'?'Your session has ended. Log out and in again to see what is new.'
        :HF_INBOX.problem==='down'?'Could not check right now. Try again in a moment.':'Looking…')+'</div>';
    return;
  }
  if(!list.length){
    panel.innerHTML='<div class="hf-bell-head">Notifications</div>'
      +'<div class="hf-bell-empty">Nothing new. When a restaurant answers your message, it shows here.</div>';
    return;
  }
  panel.innerHTML='<div class="hf-bell-head">Notifications</div>'+list.map(function(b){
    return '<a class="hf-bell-item" href="/reservations#chat='+Number(b.reservationId)+'">'
      +'<b>'+hfEsc(b.who)+' · '+hfEsc(b.restaurant)+' answered you</b>'
      +'<span>Your table: '+hfEsc(b.table)+'</span>'
      +'<small>'+hfEsc(b.label)+(b.count>1?' · '+Number(b.count)+' messages':'')+'</small>'
      +'</a>';
  }).join('');
}
function hfBellOpen(){
  var panel=document.getElementById('hf-bell-panel'), bell=document.getElementById('hf-bell');
  if(!panel||!bell)return;
  closeCornerMenu();
  panel.hidden=false;
  bell.setAttribute('aria-expanded','true');
  hfBellRender();
  hfInbox(true);
}
function hfBellClose(){
  var panel=document.getElementById('hf-bell-panel'), bell=document.getElementById('hf-bell');
  if(panel)panel.hidden=true;
  if(bell)bell.setAttribute('aria-expanded','false');
}
// Back on screen (another app, another tab, the phone unlocked): ask now
// unless the answer is only a few seconds old.
function hfInboxWake(){if(document.visibilityState==='visible'&&!HF_INBOX.busy&&Date.now()-HF_INBOX.at>4000)hfInbox(true);}
// Coming back to the page is someone using it; so is a touch or a key after a
// quiet minute, and then the page (window.hfOnWake) and the bell catch up now.
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')hfActive();});
['pointerdown','keydown','touchstart','wheel'].forEach(function(t){
  document.addEventListener(t,function(){
    if(hfActive()<60000)return;
    hfInboxWake();
    if(typeof window.hfOnWake==='function'){try{window.hfOnWake();}catch(e){}}
  },{passive:true,capture:true});
});
document.addEventListener('visibilitychange',hfInboxWake);
window.addEventListener('focus',hfInboxWake);
window.addEventListener('pageshow',function(e){if(e.persisted)hfInboxWake();});
HF_INBOX.timer=setInterval(function(){
  if(document.visibilityState!=='visible')return;
  if(Date.now()-Math.max(HF_INBOX.at,HF_INBOX.tried)<hfPace(HF_INBOX.every,hfStaffish()?60000:Infinity)-500)return;
  hfInbox(false);
},1000);

// One delegated listener rather than inline onclick, because the pills are
// rebuilt from scratch on every login state change.
document.addEventListener('click',function(e){
  const t=e.target;
  if(!t||!t.closest)return;
  const item=t.closest('.hf-corner-item[data-act]');
  if(item){
    closeCornerMenu();
    const act=item.getAttribute('data-act');
    if(act==='login')openTasterModal();
    else if(act==='tastings'){if(typeof openMyTastings==='function')openMyTastings();}
    else if(act==='visits'){if(typeof openMyVisits==='function')openMyVisits();}
    else if(act==='logout'){if(confirm('Log out?'))logout();}
    return;
  }
  if(t.closest('#hf-corner-toggle')){toggleCornerMenu();return;}
  if(t.closest('#hf-bell')){var p=document.getElementById('hf-bell-panel');if(p&&p.hidden)hfBellOpen();else hfBellClose();return;}
  var bellItem=t.closest('.hf-bell-item');
  if(bellItem){
    hfBellClose();
    // Already on that address: the page will not hear a change, so open it here.
    var m=/#chat=(\d+)$/.exec(bellItem.getAttribute('href')||'');
    if(m&&/^\/reservations(\.html)?$/.test(location.pathname)&&location.hash==='#chat='+m[1]&&typeof openMine==='function'){e.preventDefault();openMine(Number(m[1]));}
    return;
  }
  if(!t.closest('#hf-bell-panel'))hfBellClose();
  if(!t.closest('#hf-corner'))closeCornerMenu();
});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){closeCornerMenu();hfBellClose();if(typeof closeMyVisits==='function')closeMyVisits();}});

(function(){
  const host=document.createElement('div');
  host.innerHTML=HF_CORNER_HTML;
  while(host.firstChild)document.body.appendChild(host.firstChild);
  updateNavBtn(); // draws the logged-out state; loadSession() redraws if there is a session
})();

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

// ── MY VISITS: the check-in QR and the two calendars ────────────────────────
//
// The customer shows a QR. A member of staff points their own phone's camera
// at it, the link opens, and they press Confirm. That is the whole system, and
// the direction matters: a code printed on the table could be photographed and
// used from home, but nobody can fake a waiter standing there pressing a
// button.
//
// Nothing here draws the QR. The server does that and sends back a finished
// picture, so there is no QR library in the browser, no request to a QR
// website, and no third party that gets told a customer is at dinner.

var HF_VISITS_HTML =
  '<div class="hf-v-overlay" id="hf-v-overlay" onclick="if(event.target===this)closeMyVisits()">'
+   '<div class="hf-v-box">'
+     '<div class="hf-v-header">'
+       '<h3>My Visits</h3>'
+       '<button class="t-close" onclick="closeMyVisits()" aria-label="Close">&#10005;</button>'
+     '</div>'
+     '<div class="hf-v-body">'
+       '<div class="hf-v-checkin" id="hf-v-checkin"></div>'
+       '<div id="hf-v-calendar"></div>'
+     '</div>'
+   '</div>'
+ '</div>';

var HFV = {
  visits: [], places: [], today: '', place: 'all',
  year: 0, month: 0,           // the month on screen
  expiry: 0, refreshes: 0,
  tick: null, loaded: false
};

function openMyVisits(){
  if(!currentTaster){openTasterModal();return;}
  const o=document.getElementById('hf-v-overlay');
  if(!o)return;
  o.classList.add('open');
  hfvShowIdle();
  hfvLoadCalendar();
}
function closeMyVisits(){
  const o=document.getElementById('hf-v-overlay');
  if(o)o.classList.remove('open');
  hfvStop();
}
// Every timer this screen starts is stopped here. A countdown left running
// behind a closed dialog would keep asking the server for codes nobody can see.
function hfvStop(){
  if(HFV.tick){clearInterval(HFV.tick);HFV.tick=null;}
  HFV.expiry=0;HFV.refreshes=0;
}

function hfvApi(path, body){
  return fetch(path,{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+currentSession},
    body:JSON.stringify(body||{})
  }).then(function(res){
    return res.text().then(function(text){
      var data=null;
      try{data=text?JSON.parse(text):null;}catch(e){}
      if(data===null&&!res.ok){
        throw new Error('The server returned '+res.status+' instead of data.');
      }
      if(!res.ok)throw new Error((data&&data.error)||'Something went wrong.');
      return data||{};
    });
  });
}

// ── The check-in code ──
function hfvShowIdle(){
  hfvStop();
  const box=document.getElementById('hf-v-checkin');
  if(!box)return;
  box.innerHTML=
    '<button class="t-btn" id="hf-v-go" onclick="hfvRequestCode()">Check In</button>'
  + '<div class="hf-v-qr-msg" style="margin-top:.75rem;">Tap this at the restaurant, then show the code to your waiter.</div>';
}

function hfvRequestCode(){
  const box=document.getElementById('hf-v-checkin');
  if(!box)return;
  box.innerHTML='<div class="hf-v-qr-msg">Making your code…</div>';
  hfvApi('/api/checkins',{action:'token'}).then(function(d){
    // The SVG comes from our own server, but it goes into innerHTML, so it is
    // still checked for being what it claims to be before it gets there.
    const svg=(typeof d.svg==='string'&&d.svg.trim().slice(0,4)==='<svg')?d.svg:'';
    if(!svg)throw new Error('Could not draw your code.');
    HFV.expiry=new Date(d.expiresAt).getTime();
    box.innerHTML=
      '<div class="hf-v-qr" id="hf-v-qr">'+svg+'</div>'
    + '<div class="hf-v-bar"><i id="hf-v-bar"></i></div>'
    + (d.shortCode
        ? '<div class="hf-v-code">'+hfEsc(d.shortCode)+'</div>'
          +'<div class="hf-v-code-note">If the camera will not read it, your waiter can type these six characters.</div>'
        : '')
    + '<div class="hf-v-qr-msg" id="hf-v-msg" style="margin-top:.7rem;">Show this to your waiter.</div>';
    hfvStartCountdown();
  }).catch(function(e){
    box.innerHTML=
      '<div class="t-err" style="display:block;">'+hfEsc(e.message||'Could not get a code.')+'</div>'
    + '<button class="t-btn" onclick="hfvRequestCode()">Try again</button>';
  });
}

function hfvStartCountdown(){
  if(HFV.tick)clearInterval(HFV.tick);
  const total=Math.max(1,HFV.expiry-Date.now());
  HFV.tick=setInterval(function(){
    const bar=document.getElementById('hf-v-bar');
    const left=HFV.expiry-Date.now();
    if(bar)bar.style.width=Math.max(0,Math.min(100,(left/total)*100))+'%';
    if(left>0)return;

    clearInterval(HFV.tick);HFV.tick=null;
    // A code that has run out is replaced automatically, because the customer
    // is standing at a table and should not have to think about it. But an
    // account left open on a kitchen counter must not ask forever, so after
    // about a quarter of an hour it stops and waits to be asked.
    HFV.refreshes++;
    if(HFV.refreshes<=10){hfvRequestCode();return;}
    const box=document.getElementById('hf-v-checkin');
    if(box)box.innerHTML=
      '<div class="hf-v-qr-msg" style="margin-bottom:.8rem;">That code expired.</div>'
    + '<button class="t-btn" onclick="hfvRequestCode()">Show a new code</button>';
  },200);
}

// ── The calendars ──
function hfvLoadCalendar(){
  const box=document.getElementById('hf-v-calendar');
  if(!box)return;
  if(!HFV.loaded)box.innerHTML='<div class="hf-v-empty">Loading your visits…</div>';
  hfvApi('/api/checkins',{action:'list'}).then(function(d){
    HFV.visits=Array.isArray(d.visits)?d.visits:[];
    HFV.places=Array.isArray(d.restaurants)?d.restaurants:[];
    // The restaurant's clock, not the phone's. Someone opening this from
    // California should still see the New York day marked.
    HFV.today=d.today||'';
    if(!HFV.year){
      const parts=(HFV.today||'1970-01-01').split('-');
      HFV.year=Number(parts[0]);HFV.month=Number(parts[1])-1;
    }
    HFV.loaded=true;
    hfvRender();
  }).catch(function(e){
    box.innerHTML='<div class="hf-v-empty">'+hfEsc(e.message||'Could not load your visits.')+'</div>';
  });
}

function hfvPick(id){HFV.place=id;hfvRender();}
function hfvMonthStep(n){
  var m=HFV.month+n, y=HFV.year;
  if(m<0){m=11;y--;}
  if(m>11){m=0;y++;}
  HFV.year=y;HFV.month=m;
  hfvRender();
}

function hfvPad(n){return (n<10?'0':'')+n;}
function hfvKey(y,m,d){return y+'-'+hfvPad(m+1)+'-'+hfvPad(d);}

function hfvRender(){
  const box=document.getElementById('hf-v-calendar');
  if(!box)return;

  if(!HFV.visits.length){
    box.innerHTML='<div class="hf-v-empty">No visits yet.<br>Check in at a restaurant and this fills up.</div>';
    return;
  }

  // The two calendars Sebastian asked for are one calendar and a filter: "All"
  // is every restaurant together, and each pill is that restaurant on its own.
  const mine=HFV.place==='all'
    ? HFV.visits
    : HFV.visits.filter(function(v){return String(v.restaurantId)===String(HFV.place);});
  // How many visits fell on each day, not merely whether one did. On the "All"
  // view a person can lunch at one restaurant and dine at another, which is two
  // visits on one square — and a tally that counted squares would disagree with
  // the all-time total sitting next to it.
  const days={};
  mine.forEach(function(v){days[v.date]=(days[v.date]||0)+1;});

  // A row of pills was fine for two restaurants and fell apart at twenty — it
  // wrapped to three lines and pushed the calendar off the screen. A dropdown
  // is one line tall whatever the number, and it is the same control the
  // manager page already uses to switch restaurant.
  //
  // Each line carries its own count, so choosing between twenty restaurants
  // does not mean opening twenty of them to find out.
  const counts={};
  HFV.visits.forEach(function(v){
    counts[v.restaurantId]=(counts[v.restaurantId]||0)+1;
  });
  const sorted=HFV.places.slice().sort(function(a,b){
    return String(a.name||'').localeCompare(String(b.name||''));
  });

  var pills='<select class="hf-v-select" id="hf-v-place" aria-label="Which restaurant"'
    + ' onchange="hfvPick(this.value)">'
    + '<option value="all"'+(HFV.place==='all'?' selected':'')+'>'
    +   'All restaurants &nbsp;&middot;&nbsp; '+HFV.visits.length
    +   (HFV.visits.length===1?' visit':' visits')
    + '</option>';
  sorted.forEach(function(p){
    const n=counts[p.id]||0;
    pills+='<option value="'+hfEsc(p.id)+'"'+(String(HFV.place)===String(p.id)?' selected':'')+'>'
      + hfEsc(p.name)+' &nbsp;&middot;&nbsp; '+n+(n===1?' visit':' visits')
      + '</option>';
  });
  pills+='</select>';

  const monthName=new Date(Date.UTC(HFV.year,HFV.month,1))
    .toLocaleDateString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});

  // Nobody has visits in the future, so the forward arrow stops at this month.
  const nowParts=(HFV.today||'1970-01-01').split('-');
  const atNow=(HFV.year>Number(nowParts[0]))||(HFV.year===Number(nowParts[0])&&HFV.month>=Number(nowParts[1])-1);

  var head='<div class="hf-v-month">'
    + '<button class="hf-v-arrow" onclick="hfvMonthStep(-1)" aria-label="Previous month">&#8249;</button>'
    + '<div class="hf-v-month-name">'+hfEsc(monthName)+'</div>'
    + '<button class="hf-v-arrow" onclick="hfvMonthStep(1)" aria-label="Next month"'+(atNow?' disabled':'')+'>&#8250;</button>'
    + '</div>';

  var grid='<div class="hf-v-grid">';
  ['S','M','T','W','T','F','S'].forEach(function(d){grid+='<div class="hf-v-dow">'+d+'</div>';});
  const first=new Date(Date.UTC(HFV.year,HFV.month,1)).getUTCDay();
  const total=new Date(Date.UTC(HFV.year,HFV.month+1,0)).getUTCDate();
  for(var i=0;i<first;i++)grid+='<div class="hf-v-day empty"></div>';
  var thisMonth=0;
  for(var d=1;d<=total;d++){
    const key=hfvKey(HFV.year,HFV.month,d);
    const count=days[key]||0;
    var cls='hf-v-day';
    if(count){cls+=' went';thisMonth+=count;}
    // Two restaurants in one day is one square but two visits, so the square
    // says so rather than quietly hiding one of them.
    if(count>1)cls+=' multi';
    if(key===HFV.today)cls+=' today';
    grid+='<div class="'+cls+'"'+(count>1?' title="'+count+' visits"':'')+'>'+d
       +(count>1?'<i class="hf-v-dots">'+new Array(Math.min(count,3)+1).join('&bull;')+'</i>':'')
       +'</div>';
  }
  grid+='</div>';

  const last=mine.length?mine.map(function(v){return v.date;}).sort().pop():null;
  const lastLabel=last
    ? new Date(last+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'})
    : '—';

  const tally='<div class="hf-v-tally">'
    + '<div><b>'+thisMonth+'</b><span>This month</span></div>'
    + '<div><b>'+mine.length+'</b><span>All time</span></div>'
    + '<div><b>'+hfEsc(lastLabel)+'</b><span>Last visit</span></div>'
    + '</div>';

  box.innerHTML=pills+head+grid+tally;
}

(function(){
  const host=document.createElement('div');
  host.innerHTML=HF_VISITS_HTML;
  while(host.firstChild)document.body.appendChild(host.firstChild);
})();
