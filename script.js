let nurses = [];
let patients = [];

// -------------------------
// Nurse Setup
// -------------------------
function setupNurses() {
  const count = parseInt(document.getElementById("nurseCount").value);
  nurses = [];

  for (let i = 0; i < count; i++) {
    nurses.push({
      id: i + 1,
      type: "tele",        // default
      maxPatients: 4,
      patients: []
    });
  }

  renderNurseList();
}

function renderNurseList() {
  const container = document.getElementById("nurseList");
  container.innerHTML = "";

  nurses.forEach((n, index) => {
    container.innerHTML += `
      <div class="nurseRow">
        Nurse ${n.id}:
        <select onchange="updateNurseType(${index}, this.value)">
          <option value="tele">Tele (max 4)</option>
          <option value="ms">Med-Surg (max 5)</option>
        </select>
      </div>
    `;
  });
}

function updateNurseType(index, value) {
  nurses[index].type = value;
  nurses[index].maxPatients = value === "tele" ? 4 : 5;
}

// -------------------------
// Patient Setup
// -------------------------
function addPatient() {
  const id = patients.length + 1;

  const newPatient = {
    id,
    room: "",
    tele: false,
    drip: false,
    nih: false,
    bg: false,
    ciwa: false,
    restraint: false,
    sitter: false,
    vpo: false,
    isolation: false
  };

  patients.push(newPatient);
  renderPatientList();
}

function updatePatient(id, field, value) {
  const p = patients.find(pt => pt.id === id);
  p[field] = value;
}

function renderPatientList() {
  const container = document.getElementById("patientList");
  container.innerHTML = "";

  patients.forEach(p => {
    container.innerHTML += `
      <div class="patientRow">
        Room: <input type="text" onchange="updatePatient(${p.id}, 'room', this.value)">

        <label><input type="checkbox" onchange="updatePatient(${p.id}, 'tele', this.checked)"> Tele</label>
        <label><input type="checkbox" onchange="updatePatient(${p.id}, 'drip', this.checked)"> Drip</label>
        <label><input type="checkbox" onchange="updatePatient(${p.id}, 'nih', this.checked)"> NIH</label>
        <label><input type="checkbox" onchange="updatePatient(${p.id}, 'bg', this.checked)"> BG</label>
        <label><input type="checkbox" onchange="updatePatient(${p.id}, 'ciwa', this.checked)"> CIWA/COWS</label>
        <label><input type="checkbox" onchange="updatePatient(${p.id}, 'restraint', this.checked)"> Restraint</label>
        <label><input type="checkbox" onchange="updatePatient(${p.id}, 'sitter', this.checked)"> Sitter</label>
        <label><input type="checkbox" onchange="updatePatient(${p.id}, 'vpo', this.checked)"> VPO</label>
        <label><input type="checkbox" onchange="updatePatient(${p.id}, 'isolation', this.checked)"> Isolation</label>
      </div>
    `;
  });
}

// -------------------------
// Assignment Engine (very simple prototype)
// -------------------------
function generateAssignment() {
  // reset nurse assignments
  nurses.forEach(n => n.patients = []);

  // super basic: just fill nurses in order up to maxPatients
  let nurseIndex = 0;

  patients.forEach(p => {
    let assigned = false;
    let tries = 0;

    while (!assigned && tries < nurses.length) {
      const nurse = nurses[nurseIndex];

      if (nurse.patients.length < nurse.maxPatients) {
        nurse.patients.push(p);
        assigned = true;
      } else {
        nurseIndex = (nurseIndex + 1) % nurses.length;
        tries++;
      }
    }
  });

  renderAssignmentOutput();
}

function renderAssignmentOutput() {
  const container = document.getElementById("assignmentOutput");
  container.innerHTML = "";

  nurses.forEach(n => {
    container.innerHTML += `
      <div class="nurseBlock">
        <h3>Nurse ${n.id} (${n.type.toUpperCase()})</h3>
        <table>
          <tr>
            <th>Room</th>
            <th>Level</th>
            <th>Acuity Notes</th>
          </tr>
          ${
            n.patients.map(p => {
              const level = p.tele ? "Tele" : "MS";
              const notes = [
                p.drip && "Drip",
                p.nih && "NIH",
                p.bg && "BG",
                p.ciwa && "CIWA/COWS",
                p.restraint && "Restraint",
                p.sitter && "Sitter",
                p.vpo && "VPO",
                p.isolation && "Isolation"
              ].filter(Boolean).join(", ") || "—";

              return `
                <tr>
                  <td>${p.room || "(no room)"}</td>
                  <td>${level}</td>
                  <td>${notes}</td>
                </tr>
              `;
            }).join("")
          }
        </table>
      </div>
    `;
  });
}
