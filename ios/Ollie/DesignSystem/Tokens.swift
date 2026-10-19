import SwiftUI

/// Gui's design system, v1, mirrored for SwiftUI.
///
/// Source of truth: `~/Developer/design-system/tokens/tokens.json`. This file
/// copies the `mapped`, `responsive` (mobile mode) and `motion` tiers and
/// nothing else; views read these names, never a raw hex. Change a value
/// there first, then here, never only here.
///
/// The system is achromatic on purpose. Red means error or destructive and
/// nothing else, and there is no success or warning colour: state is carried
/// by an icon and a word on a neutral surface. That includes gain and loss,
/// which this app used to paint teal and red-orange; a sign and an arrow carry
/// them now, which they already did for anyone who cannot tell the two apart.
enum DS {
    // MARK: Colour (mapped tier, dark default and light)

    enum Text {
        static let primary = DS.color(dark: 0xFAFAFA, light: 0x171717)
        static let secondary = DS.color(dark: 0xA3A3A3, light: 0x525252)
        static let tertiary = DS.color(dark: 0x8C8C8C, light: 0x737373)
        static let disabled = DS.color(dark: 0x8C8C8C, light: 0x737373)
        static let action = DS.color(dark: 0xFFFFFF, light: 0x171717)
        static let onAction = DS.color(dark: 0x171717, light: 0xFFFFFF)
        static let error = DS.color(dark: 0xF87171, light: 0xDC2626)
        static let onError = DS.color(dark: 0xFFFFFF, light: 0xFFFFFF)
    }

    /// Matches `Text` one to one, so a glyph and its label never drift apart.
    typealias Icon = Text

    enum Surface {
        static let page = DS.color(dark: 0x171717, light: 0xFFFFFF)
        static let `default` = DS.color(dark: 0x1F1F1F, light: 0xFAFAFA)
        static let raised = DS.color(dark: 0x262626, light: 0xFFFFFF)
        static let field = DS.color(dark: 0x1F1F1F, light: 0xFFFFFF)
        static let hover = DS.color(dark: 0x262626, light: 0xF5F5F5)
        static let selected = DS.color(dark: 0x404040, light: 0xE5E5E5)
        static let action = DS.color(dark: 0xFFFFFF, light: 0x171717)
        static let actionHover = DS.color(dark: 0xE5E5E5, light: 0x262626)
        static let disabled = DS.color(dark: 0x262626, light: 0xFAFAFA)
        static let error = DS.color(dark: 0xDC2626, light: 0xDC2626)
        static let errorHover = DS.color(dark: 0xB91C1C, light: 0xB91C1C)
    }

    enum Border {
        static let `default` = DS.color(dark: 0x262626, light: 0xE5E5E5)
        static let strong = DS.color(dark: 0x404040, light: 0xD4D4D4)
        /// 3:1 against page and surfaces. Edges of inputs and unchecked controls.
        static let control = DS.color(dark: 0x737373, light: 0x8C8C8C)
        static let controlHover = DS.color(dark: 0xA3A3A3, light: 0x525252)
        static let action = DS.color(dark: 0xFFFFFF, light: 0x171717)
        static let focus = DS.color(dark: 0xFFFFFF, light: 0x171717)
        static let disabled = DS.color(dark: 0x262626, light: 0xE5E5E5)
        static let error = DS.color(dark: 0xF87171, light: 0xDC2626)
    }

    enum Effect {
        /// Behind modals only.
        static let scrim = Color(UIColor { traits in
            UIColor(white: 0, alpha: traits.userInterfaceStyle == .dark ? 0.6 : 0.4)
        })
    }

    // MARK: Layout (responsive tier, mobile mode)

    enum Space {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 12
        static let lg: CGFloat = 16
        static let xl: CGFloat = 20
        static let xxl: CGFloat = 24
        static let xxxl: CGFloat = 32
    }

    static let pageMargin: CGFloat = 16
    static let hitTarget: CGFloat = 44

    enum Radius {
        static let sm: CGFloat = 4
        static let md: CGFloat = 8
        static let lg: CGFloat = 12
        static let xl: CGFloat = 16
    }

    enum BorderWidth {
        static let sm: CGFloat = 1
        static let md: CGFloat = 2
    }

    enum ControlHeight {
        static let sm: CGFloat = 36
        static let md: CGFloat = 44
        static let lg: CGFloat = 52
    }

    // MARK: Motion

    /// Emil Kowalski's curves and Apple's springs, as the token file states them.
    /// Only transform and opacity animate. Nothing keyboard-triggered animates.
    enum Motion {
        /// Entering, exiting, or answering the user. The default.
        static func out(_ duration: Double) -> Animation {
            .timingCurve(0.23, 1, 0.32, 1, duration: duration)
        }
        /// Something already on screen moving from A to B.
        static func inOut(_ duration: Double) -> Animation {
            .timingCurve(0.77, 0, 0.175, 1, duration: duration)
        }

        static let press: Double = 0.16
        static let fast: Double = 0.15
        static let base: Double = 0.2
        static let modal: Double = 0.25
        /// The crossfade that replaces movement under Reduce Motion.
        static let reduced: Double = 0.15

        /// Critically damped. Anything touchable.
        static let spring = Animation.spring(duration: 0.4, bounce: 0)
        /// Only after a flick or a throw.
        static let momentum = Animation.spring(duration: 0.4, bounce: 0.2)

        static let pressScale: CGFloat = 0.97
        static let enterScale: CGFloat = 0.95
    }

    // MARK: Helpers

    static func color(dark: UInt32, light: UInt32) -> Color {
        Color(UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}
