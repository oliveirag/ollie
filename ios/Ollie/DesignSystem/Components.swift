import SwiftUI

// The design system's components (COMPONENTS.md, v1), built on SwiftUI's own
// controls so they keep their accessibility traits, keyboard support and
// system behaviour. Only the drawing is ours.

// MARK: - Page

/// A scrolling page on `surface.page`, with the mobile page margin and the
/// spacing between sections. Every screen is one of these.
struct DSPage<Content: View>: View {
    var spacing: CGFloat = DS.Space.xxl
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: spacing) {
                content()
            }
            .padding(.horizontal, DS.pageMargin)
            .padding(.top, DS.Space.sm)
            .padding(.bottom, DS.Space.xxxl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(DS.Surface.page)
        .scrollIndicators(.hidden)
        .modifier(HardTopEdge())
    }
}

/// Content scrolling under an inline title reads poorly through the soft
/// default edge on a flat page; the hard edge gives the bar a clean line, the
/// "scroll edge effect, not a divider" the Apple guidance asks for.
private struct HardTopEdge: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.scrollEdgeEffectStyle(.hard, for: .top)
        } else {
            content
        }
    }
}

// MARK: - Section and card

/// A titled group: a caption header, a card, and an optional footer. The
/// header and footer sit outside the card, like a grouped list, so the card
/// holds only content.
struct DSSection<Content: View>: View {
    var title: String?
    var footer: String?
    var padded = true
    @ViewBuilder let content: () -> Content

    init(_ title: String? = nil, footer: String? = nil, padded: Bool = true, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.footer = footer
        self.padded = padded
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.sm) {
            if let title {
                DSSectionHeader(title)
            }
            DSCard(padded: padded, content: content)
            if let footer {
                Text(footer)
                    .dsFont(.caption)
                    .foregroundStyle(DS.Text.secondary)
                    .padding(.horizontal, DS.Space.xs)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct DSSectionHeader: View {
    let title: String
    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .dsFont(.caption)
            .foregroundStyle(DS.Text.secondary)
            .padding(.horizontal, DS.Space.xs)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Card: `surface.default`, a 1px `border.default` stroke, radius lg. Dark
/// mode shows depth with the lighter surface and the border, not a shadow.
struct DSCard<Content: View>: View {
    var padded = true
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content()
        }
        .padding(padded ? DS.Space.lg : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DS.Surface.default, in: RoundedRectangle(cornerRadius: DS.Radius.lg, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: DS.Radius.lg, style: .continuous)
                .strokeBorder(DS.Border.default, lineWidth: DS.BorderWidth.sm)
        }
    }
}

/// A 1px `border.default` rule between rows of one card.
struct DSDivider: View {
    var inset: CGFloat = 0

    var body: some View {
        Rectangle()
            .fill(DS.Border.default)
            .frame(height: 1)
            .padding(.leading, inset)
    }
}

/// Rows of a padding-less card, each 44pt or taller, split by dividers.
struct DSRows<Data: RandomAccessCollection, ID: Hashable, Row: View>: View {
    let data: Data
    let id: KeyPath<Data.Element, ID>
    @ViewBuilder let row: (Data.Element) -> Row

    init(_ data: Data, id: KeyPath<Data.Element, ID>, @ViewBuilder row: @escaping (Data.Element) -> Row) {
        self.data = data
        self.id = id
        self.row = row
    }

    var body: some View {
        ForEach(Array(data.enumerated()), id: \.offset) { index, element in
            if index > 0 { DSDivider(inset: DS.Space.lg) }
            row(element)
                .padding(.horizontal, DS.Space.lg)
                .padding(.vertical, DS.Space.md)
                .frame(maxWidth: .infinity, minHeight: DS.hitTarget, alignment: .leading)
        }
    }
}

/// Label leading, value trailing, at least 44pt tall.
struct DSValueRow<Value: View>: View {
    let label: String
    @ViewBuilder let value: () -> Value

    init(_ label: String, @ViewBuilder value: @escaping () -> Value) {
        self.label = label
        self.value = value
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Space.md) {
            Text(label)
                .dsFont(.body)
                .foregroundStyle(DS.Text.primary)
            Spacer(minLength: DS.Space.sm)
            value()
        }
        .frame(minHeight: DS.hitTarget - 2 * DS.Space.md)
    }
}

extension DSValueRow where Value == AnyView {
    init(_ label: String, text: String, style: Color = DS.Text.secondary) {
        self.init(label) {
            AnyView(Text(text).dsFont(.body).foregroundStyle(style).monospacedDigit())
        }
    }
}

// MARK: - Button

enum DSButtonVariant { case primary, secondary, ghost, destructive }
enum DSButtonSize { case small, medium, large }

/// Primary is the inverse of the page (the mono accent), one per view.
/// Destructive is the only red button and means it. Press feedback is a
/// 0.97 scale on touch-down, 160ms on the strong ease-out, and none at all
/// under Reduce Motion.
struct DSButtonStyle: ButtonStyle {
    var variant: DSButtonVariant = .primary
    var size: DSButtonSize = .medium
    var fullWidth = true

    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled

        configuration.label
            .dsFont(size == .small ? .bodySmall : .body, weight: .bold)
            .lineLimit(2)
            .multilineTextAlignment(.center)
            .foregroundStyle(foreground)
            .padding(.horizontal, size == .small ? DS.Space.md : DS.Space.lg)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .frame(minHeight: height)
            .background(background(pressed: pressed), in: shape)
            .overlay { shape.strokeBorder(stroke, lineWidth: DS.BorderWidth.sm) }
            .contentShape(shape)
            // Small buttons keep a 44pt hit area around a smaller visual.
            .padding(.vertical, size == .small ? (DS.hitTarget - height) / 2 : 0)
            .contentShape(Rectangle())
            .scaleEffect(pressed && !reduceMotion ? DS.Motion.pressScale : 1)
            .animation(DS.Motion.out(DS.Motion.press), value: pressed)
    }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: DS.Radius.md, style: .continuous)
    }

    private var height: CGFloat {
        switch size {
        case .small: DS.ControlHeight.sm
        case .medium: DS.ControlHeight.md
        case .large: DS.ControlHeight.lg
        }
    }

    private var foreground: Color {
        guard isEnabled else { return DS.Text.disabled }
        switch variant {
        case .primary: return DS.Text.onAction
        case .secondary, .ghost: return DS.Text.primary
        case .destructive: return DS.Text.onError
        }
    }

    private func background(pressed: Bool) -> Color {
        // Disabled is a flat surface with readable text, never faded text.
        guard isEnabled else { return DS.Surface.disabled }
        switch variant {
        case .primary: return pressed ? DS.Surface.actionHover : DS.Surface.action
        case .secondary: return pressed ? DS.Surface.hover : DS.Surface.default
        case .ghost: return pressed ? DS.Surface.hover : .clear
        case .destructive: return pressed ? DS.Surface.errorHover : DS.Surface.error
        }
    }

    /// Every component has a stroke, even when it matches the fill.
    private var stroke: Color {
        guard isEnabled else { return DS.Surface.disabled }
        switch variant {
        case .primary: return DS.Surface.action
        case .secondary: return DS.Border.strong
        case .ghost: return .clear
        case .destructive: return DS.Surface.error
        }
    }
}

extension ButtonStyle where Self == DSButtonStyle {
    static func ds(_ variant: DSButtonVariant = .primary, size: DSButtonSize = .medium, fullWidth: Bool = true) -> DSButtonStyle {
        DSButtonStyle(variant: variant, size: size, fullWidth: fullWidth)
    }
}

/// A whole row that navigates: content, then a chevron. Press dims the row
/// to `surface.hover` instantly; rows are seen tens of times a day, so they
/// get colour feedback and no movement.
struct DSRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: DS.Space.sm) {
            configuration.label
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(DS.Icon.tertiary)
                .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
        .background(configuration.isPressed ? DS.Surface.hover : .clear)
    }
}

// MARK: - Badge

enum DSBadgeVariant { case neutral, solid, outline, error }

/// Not clickable. Status is an icon and a word, never a colour on its own.
struct DSBadge: View {
    let label: String
    var icon: String?
    var variant: DSBadgeVariant = .neutral

    var body: some View {
        HStack(spacing: DS.Space.xs) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                    .accessibilityHidden(true)
            }
            Text(label).dsFont(.caption)
        }
        .foregroundStyle(foreground)
        .padding(.horizontal, DS.Space.sm)
        .frame(minHeight: 24)
        .background(background, in: RoundedRectangle(cornerRadius: DS.Radius.sm, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: DS.Radius.sm, style: .continuous)
                .strokeBorder(stroke, lineWidth: DS.BorderWidth.sm)
        }
        .fixedSize()
    }

    private var foreground: Color {
        switch variant {
        case .neutral, .outline: DS.Text.primary
        case .solid: DS.Text.onAction
        case .error: DS.Text.error
        }
    }

    private var background: Color {
        switch variant {
        case .neutral: DS.Surface.raised
        case .solid: DS.Surface.action
        case .outline, .error: .clear
        }
    }

    private var stroke: Color {
        switch variant {
        case .neutral: DS.Border.strong
        case .solid: DS.Surface.action
        case .outline: DS.Border.control
        case .error: DS.Border.error
        }
    }
}

// MARK: - Notice

/// Inline status: icon plus words on a neutral surface. The error variant is
/// the one place this gets red.
struct DSNotice: View {
    let title: String
    var message: String?
    var icon: String = "info.circle"
    var isError = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Space.md) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(isError ? DS.Icon.error : DS.Icon.primary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: DS.Space.xs) {
                Text(title)
                    .dsFont(.bodySmall, weight: .bold)
                    .foregroundStyle(isError ? DS.Text.error : DS.Text.primary)
                if let message {
                    Text(message)
                        .dsFont(.bodySmall)
                        .foregroundStyle(DS.Text.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(DS.Space.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DS.Surface.default, in: RoundedRectangle(cornerRadius: DS.Radius.lg, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: DS.Radius.lg, style: .continuous)
                .strokeBorder(isError ? DS.Border.error : DS.Border.strong, lineWidth: DS.BorderWidth.sm)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Empty state

struct DSEmptyState: View {
    let title: String
    let message: String
    let icon: String

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.sm) {
            Image(systemName: icon)
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(DS.Icon.secondary)
                .padding(.bottom, DS.Space.xs)
                .accessibilityHidden(true)
            Text(title)
                .dsFont(.body, weight: .bold)
                .foregroundStyle(DS.Text.primary)
            Text(message)
                .dsFont(.bodySmall)
                .foregroundStyle(DS.Text.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Toggle

/// Label leads, switch trails. On is the mono accent with the inverse knob;
/// off is a `border.control` edge, which keeps the 3:1 an iOS grey track
/// would not. The knob moves on the critically damped spring and can be
/// reversed mid-flight; under Reduce Motion it simply jumps.
struct DSToggleStyle: ToggleStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            HStack(alignment: .center, spacing: DS.Space.md) {
                configuration.label
                    .dsFont(.body)
                    .foregroundStyle(isEnabled ? DS.Text.primary : DS.Text.disabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                track(on: configuration.isOn)
            }
            .frame(minHeight: DS.hitTarget)
            .contentShape(Rectangle())
        }
        // Not `.plain`, which fades disabled content. Disabled here is
        // drawn with readable tokens instead.
        .buttonStyle(BareButtonStyle())
        .accessibilityRepresentation {
            // The system toggle underneath, so VoiceOver and UI tests see a
            // switch with a value rather than a button.
            Toggle(isOn: configuration.$isOn) { configuration.label }
        }
    }

    private func track(on: Bool) -> some View {
        let fill: Color = !isEnabled ? DS.Surface.disabled : (on ? DS.Surface.action : DS.Surface.field)
        let edge: Color = !isEnabled ? DS.Border.disabled : (on ? DS.Surface.action : DS.Border.control)
        let knob: Color = !isEnabled ? DS.Icon.disabled : (on ? DS.Icon.onAction : DS.Icon.secondary)

        return Capsule()
            .fill(fill)
            .overlay { Capsule().strokeBorder(edge, lineWidth: DS.BorderWidth.sm) }
            .frame(width: 48, height: 28)
            .overlay(alignment: on ? .trailing : .leading) {
                Circle()
                    .fill(knob)
                    .frame(width: 20, height: 20)
                    .padding(DS.Space.xs)
            }
            .animation(reduceMotion ? nil : DS.Motion.spring, value: on)
    }
}

private struct BareButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { configuration.label }
}

extension ToggleStyle where Self == DSToggleStyle {
    static var ds: DSToggleStyle { DSToggleStyle() }
}

// MARK: - Input

/// Input: label above, 44pt field on `surface.field`, `border.control` edge
/// (3:1), `border.focus` at 2px while editing.
struct DSTextField: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    var secure = false
    var helper: String?

    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.sm) {
            Text(label)
                .dsFont(.bodySmall, weight: .bold)
                .foregroundStyle(DS.Text.primary)

            Group {
                if secure {
                    SecureField(placeholder, text: $text)
                } else {
                    TextField(placeholder, text: $text)
                }
            }
            .dsFont(.body)
            .foregroundStyle(DS.Text.primary)
            .focused($focused)
            .padding(.horizontal, DS.Space.md)
            .frame(minHeight: DS.ControlHeight.md)
            .background(DS.Surface.field, in: RoundedRectangle(cornerRadius: DS.Radius.md, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: DS.Radius.md, style: .continuous)
                    .strokeBorder(focused ? DS.Border.focus : DS.Border.control,
                                  lineWidth: focused ? DS.BorderWidth.md : DS.BorderWidth.sm)
            }

            if let helper {
                Text(helper)
                    .dsFont(.caption)
                    .foregroundStyle(DS.Text.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// MARK: - Code

/// A code block: the one place ligatures stay on.
struct DSCodeBlock: View {
    let text: String

    var body: some View {
        Text(text)
            .dsFont(.code)
            .foregroundStyle(DS.Text.primary)
            .textSelection(.enabled)
            .padding(DS.Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(DS.Surface.page, in: RoundedRectangle(cornerRadius: DS.Radius.md, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: DS.Radius.md, style: .continuous)
                    .strokeBorder(DS.Border.default, lineWidth: DS.BorderWidth.sm)
            }
    }
}

// MARK: - Labelled value

/// A caption over a value, for the small fact grids at the top of a detail.
struct DSFact: View {
    let label: String
    let value: String

    init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.xs) {
            Text(label).dsFont(.caption).foregroundStyle(DS.Text.secondary)
            Text(value).dsFont(.body, weight: .bold).foregroundStyle(DS.Text.primary)
        }
        .accessibilityElement(children: .combine)
    }
}
